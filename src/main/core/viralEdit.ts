// Turns one accepted clip's structure decision (`structurePick.ts`) into a
// full re-edit: the one evidence-based "house look" (silences trimmed but the
// pre-punchline pause kept, a single snap punch-in zoom on the peak, sound
// effects used sparingly, a loop ending when the rule engine allows one)
// applied through a small per-structure recipe. Pure: no I/O, no FFmpeg.
// `edlFilter.ts` turns the result into a filter graph and `edlCaptions.ts`
// remaps the clip's own words onto it; nothing here invents on-screen text --
// a quote card or chat bubble only ever repeats the clip's own words or a
// real chat message.
//
// `buildViralEdit` only takes the structure decision, the clip's facts and the
// SFX file paths (plus the rule engine's own switches, see `ViralEditOptions`): everything else (where the peak sits, how much build-up
// there is, the sub-peaks) is recomputed from `computeSignals(facts)`, the
// same pure function `structurePick.ts` used to make the decision in the
// first place, so the two are always consistent with each other.

import type { ChatMessage, Word } from '@shared/types'
import type { ColdOpenPlan } from '@shared/editPlan'
import type { Edl, EdlSegment, Ending, FreezeCue, OverlayCue, SfxCue, ZoomKeyframe } from './edl'
import { concatDuration, freezeTotal, segmentDuration, sourceToOutputTime } from './edl'
import { dbAt, EDIT_RULES, envelopeFromLoudness, firstEventSec, hookStartSec, isLoudGap, medianDb, shiftEnvelope, speechFloorDb, type Envelope } from './editRules'
import type { StructureDecision } from './structurePick'
import { computeSignals, type ClipFacts, type StructureSignals, type WordSpan } from './structureSignals'
import { wordsIn } from './transcript'

export type SfxKind = 'boom' | 'whoosh' | 'pop'

export interface ViralEditOptions {
  /**
   * Pre-rendered SFX files (see `sfx.ts`), paths relative to the FFmpeg
   * working directory. A missing kind's cue is just left out -- the edit
   * degrades to no sound effect there, never a crash or a placeholder.
   */
  sfx?: Partial<Record<SfxKind, string>>
  /**
   * A finer loudness envelope than the job's per-second log (measured from the
   * downloaded clip at edit time, VOD seconds). Lets the pacing tell game
   * sound in a pause from dead air; without it the log is used.
   */
  envelope?: Envelope | null
  /** Skip the pause, lead-in and tail trimming (the edit the 10 s floor gave up on): the whole cut is kept as one segment. */
  plain?: boolean
  /** End the edit here (clip-relative seconds) with a replay-friendly loop ending. */
  loop?: { endSec: number; crossfadeSec: number } | null
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

// --- silence trimming -------------------------------------------------

/** What the pacing pass did, for the rule engine's log line and checks. */
export interface PacingStats {
  /** Pauses cut down. */
  cuts: number
  savedSec: number
  /** The least air left around a cut, both sides together (at least twice `minSideSec`); null with no cuts. */
  minKeptGap: number | null
  /** Pauses long enough to cut that were left because loud game sound sat in them. */
  loudGapsKept: number
  /** Clip-relative second of the first speech or reaction, before trimming; null with neither. */
  firstEventSec: number | null
  /** Clip-relative seconds the edit starts and ends at. */
  startSec: number
  endSec: number
}

interface PacingContext {
  /** Clip-relative loudness, or null. */
  env: Envelope | null
  tight: boolean
  plain: boolean
  loopEndSec: number | null
}

/** The last gap between two words that sits entirely before `peakSrcT`, or -1 with none. */
function findPrePeakGapIndex(words: Word[], peakSrcT: number): number {
  let idx = -1
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i + 1]!.t0 <= peakSrcT) idx = i
    else break
  }
  return idx
}

/** Where a word's sound really stops: its end, or later while the envelope stays at speech level (whisper's word ends sit early). */
function speechTail(env: Envelope | null, floorDb: number | null, wordEnd: number): number {
  if (!env || floorDb === null) return wordEnd
  let end = wordEnd
  const limit = wordEnd + EDIT_RULES.loop.wordEndEarlySec + env.stepSec
  for (let t = wordEnd; t < limit; t += env.stepSec) {
    const db = dbAt(env, t)
    if (db === null || db < floorDb) break
    end = t + env.stepSec
  }
  return end
}

/** Where the edit ends: the reaction's end plus a short tail, never inside the reaction beat after the payoff. */
function endSecFor(words: Word[], clipLength: number, peakSrcT: number, env: Envelope | null): number {
  const { reactionBeatMinSec, reactionSearchSec, endAfterReactionSec } = EDIT_RULES.pacing
  let reactionEnd = Math.max(words[words.length - 1]!.t1, peakSrcT + reactionBeatMinSec)
  const median = medianDb(env, 0, clipLength)
  if (env && median !== null) {
    const above = median + EDIT_RULES.hook.reactionAboveMedianDb
    // Loud frames running on from the payoff are still the reaction.
    for (let t = Math.floor(peakSrcT / env.stepSec) * env.stepSec; t < peakSrcT + reactionSearchSec; t += env.stepSec) {
      const db = dbAt(env, t)
      if (db === null || db < above) {
        if (t > peakSrcT) break
        continue
      }
      reactionEnd = Math.max(reactionEnd, t + env.stepSec)
    }
  }
  return Math.min(clipLength, reactionEnd + endAfterReactionSec)
}

/**
 * Base pass shared by every structure. Cuts dead air between words down to
 * `keepGapSec` (at least `minSideSec` of air either side of the cut), except
 * the one pause right before the peak, which is left alone up to
 * `prePeakMaxKeepSec` (only a longer one gets capped, never stretched -- there
 * is no audio to invent). A pause with loud game sound in it needs to be
 * longer before it is cut, and no cut lands inside a word or the sound of a
 * word's tail. Leading silence over `trimOverSec` is cut down to `keepSec`;
 * the tail keeps the reaction beat and a short run-out (`endSecFor`). With no
 * words at all (a transcript-free degraded clip) the whole clip is kept as one
 * segment, apart from a reaction lead-in.
 */
function trimSilences(words: Word[], clipLength: number, peakSrcT: number, ctx: PacingContext): { segments: EdlSegment[]; stats: PacingStats } {
  const stats: PacingStats = { cuts: 0, savedSec: 0, minKeptGap: null, loudGapsKept: 0, firstEventSec: null, startSec: 0, endSec: Math.max(0.05, clipLength) }
  if (clipLength <= 0) return { segments: [{ srcStart: 0, srcEnd: 0.05, speed: 1 }], stats }
  const first = firstEventSec(words, ctx.env, { from: 0, to: clipLength })
  stats.firstEventSec = first
  if (ctx.plain) return { segments: [{ srcStart: 0, srcEnd: clipLength, speed: 1 }], stats }

  const start = hookStartSec(first)
  if (words.length === 0) {
    stats.startSec = start
    return { segments: [{ srcStart: start, srcEnd: Math.max(start + 0.05, clipLength), speed: 1 }], stats }
  }

  const { pauseSec, loudGamePauseSec, tightPauseSec, keepGapSec, minSideSec, prePeakMaxKeepSec } = EDIT_RULES.pacing
  const prePeakGap = findPrePeakGapIndex(words, peakSrcT)
  const floorDb = speechFloorDb(ctx.env, words)

  const segments: EdlSegment[] = []
  let segStart = start
  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i]!
    const next = words[i + 1]!
    const gap = next.t0 - w.t1
    const isPrePeak = i === prePeakGap
    const loud = isLoudGap(ctx.env, floorDb, w.t1, next.t0)
    const cutAbove = isPrePeak ? prePeakMaxKeepSec : ctx.tight ? tightPauseSec : loud ? loudGamePauseSec : pauseSec
    if (gap <= cutAbove) {
      if (loud && gap > pauseSec) stats.loudGapsKept++
      continue
    }
    const keep = isPrePeak ? prePeakMaxKeepSec : keepGapSec
    const segEnd = Math.max(w.t1 + keep / 2, speechTail(ctx.env, floorDb, w.t1) + minSideSec)
    const nextStart = Math.min(next.t0 - keep / 2, next.t0 - minSideSec)
    // Not worth a cut that would take out less than a tenth of a second.
    if (nextStart - segEnd < 0.1) continue
    segments.push({ srcStart: segStart, srcEnd: Math.max(segStart + 0.02, segEnd), speed: 1 })
    segStart = nextStart
    stats.cuts++
    stats.savedSec += nextStart - segEnd
    // The air left around the cut, both sides together.
    stats.minKeptGap = Math.min(stats.minKeptGap ?? Infinity, gap - (nextStart - segEnd))
  }
  const wanted = ctx.loopEndSec ?? endSecFor(words, clipLength, peakSrcT, ctx.env)
  const lastEnd = clamp(wanted, segStart + 0.05, Math.max(segStart + 0.05, clipLength))
  segments.push({ srcStart: segStart, srcEnd: lastEnd, speed: 1 })
  stats.startSec = start
  stats.endSec = lastEnd
  return { segments, stats }
}

const srcToOutput = sourceToOutputTime

// --- the punch-in zoom ---------------------------------------------------

/** A punch-in of 10-15%. */
const PUNCH_SCALE = 1.13
/** The push-in `buildAndPunch` ramps to before the snap. */
const PUSH_SCALE = 1.05
/** A small zoom for rapidFire's sub-peaks -- present, but clearly a notch below the main punch. */
const SMALL_PUNCH_SCALE = 1.07
/** How long a punch takes to ease back to normal. */
const ZOOM_RELEASE_SEC = 1.4
const RAPID_ZOOM_RELEASE_SEC = 0.6
/** The sliver of time the push holds at its top just before the snap. */
const PRE_SNAP_GAP = 0.05

/** Flat at 1 until `peakT`, an instant snap to the punch scale there, then an easing release back to 1. */
function snapZoomAtPeak(peakT: number, mainDuration: number, scale = PUNCH_SCALE, releaseSec = ZOOM_RELEASE_SEC): ZoomKeyframe[] {
  const peak = clamp(peakT, 0, mainDuration)
  const releaseT = Math.min(mainDuration, peak + releaseSec)
  const kf: ZoomKeyframe[] = peak > 0 ? [{ t: 0, scale: 1, ease: 'snap' }, { t: peak, scale, ease: 'smooth' }] : [{ t: 0, scale, ease: 'smooth' }]
  if (releaseT > peak + 0.05) kf.push({ t: releaseT, scale: 1, ease: 'snap' })
  return kf
}

/** A slow push-in through the setup, then a snap the rest of the way to the full punch at the peak. */
function pushThenSnapZoom(setupT: number, peakT: number, mainDuration: number): ZoomKeyframe[] {
  const start = clamp(setupT, 0, mainDuration)
  const peak = clamp(peakT, start, mainDuration)
  if (peak - start < 0.2) return snapZoomAtPeak(peak, mainDuration)

  const releaseT = Math.min(mainDuration, peak + ZOOM_RELEASE_SEC)
  const preSnap = Math.max(start, peak - PRE_SNAP_GAP)
  const kf: ZoomKeyframe[] = [{ t: start, scale: 1, ease: 'smooth' }]
  if (preSnap > start) kf.push({ t: preSnap, scale: PUSH_SCALE, ease: 'snap' })
  kf.push({ t: peak, scale: PUNCH_SCALE, ease: 'smooth' })
  if (releaseT > peak + 0.05) kf.push({ t: releaseT, scale: 1, ease: 'snap' })
  return kf
}

/** A handful of small, independent snap-and-release bursts (rapidFire's sub-peaks), never overlapping. */
function burstZoomKeyframes(times: readonly number[], mainDuration: number): ZoomKeyframe[] {
  const sorted = [...new Set(times.map((t) => clamp(t, 0, mainDuration)))].sort((a, b) => a - b)
  const kf: ZoomKeyframe[] = []
  let cursor = 0
  for (const t of sorted) {
    if (t <= cursor) continue
    if (kf.length === 0 && t > 0) kf.push({ t: 0, scale: 1, ease: 'snap' })
    kf.push({ t, scale: SMALL_PUNCH_SCALE, ease: 'smooth' })
    const release = Math.min(mainDuration, t + RAPID_ZOOM_RELEASE_SEC)
    if (release > t + 0.05) {
      kf.push({ t: release, scale: 1, ease: 'snap' })
      cursor = release
    } else {
      cursor = t
    }
  }
  return kf.length > 0 ? kf : [{ t: 0, scale: 1, ease: 'snap' }]
}

/** Keeps candidate cue times to "at most 1-2 per 15-20 s": a minimum spacing plus an overall cap. */
function capTimeDensity(times: readonly number[], clipLength: number, minSpacing: number, maxCount: number): number[] {
  const sorted = [...times].sort((a, b) => a - b)
  const kept: number[] = []
  for (const t of sorted) {
    if (kept.length >= maxCount) break
    if (kept.length === 0 || t - kept[kept.length - 1]! >= minSpacing) kept.push(t)
  }
  return kept
}

const ZOOM_MIN_SPACING_SEC = 6
/** "At most 1-2 zooms per 15-20 s" turned into a count for a clip of this length. */
function maxZoomCount(clipLength: number): number {
  return Math.max(1, Math.round((clipLength / 17.5) * 1.5))
}

// --- sound effects, mixed low ----------------------------------------------

const BOOM_GAIN_DB = -16
const WHOOSH_GAIN_DB = -18
const POP_GAIN_DB = -20

function sfxCue(kind: SfxKind, t: number, gainDb: number, options: ViralEditOptions): SfxCue[] {
  const file = options.sfx?.[kind]
  return file ? [{ t: Math.max(0, t), file, gainDb }] : []
}
const boomCue = (t: number, options: ViralEditOptions): SfxCue[] => sfxCue('boom', t, BOOM_GAIN_DB, options)
const whooshCue = (t: number, options: ViralEditOptions): SfxCue[] => sfxCue('whoosh', t, WHOOSH_GAIN_DB, options)
const popCue = (t: number, options: ViralEditOptions): SfxCue[] => sfxCue('pop', t, POP_GAIN_DB, options)

// --- words and chat, clip-relative -----------------------------------------

/** `facts.words` clipped to the accepted window and shifted so 0 is the clip's own start (the source-clip's time 0). */
export function clipRelativeWords(facts: ClipFacts): Word[] {
  return wordsIn(facts.words, facts.window.start, facts.window.end)
    .map((w) => ({ t0: Math.max(0, w.t0 - facts.window.start), t1: Math.min(facts.window.end, w.t1) - facts.window.start, text: w.text }))
    .filter((w) => w.t1 > w.t0)
}

/** The verbatim text of a word span from the clip's own (un-shifted) word list, or null with no usable span. */
function spanText(facts: ClipFacts, span: WordSpan | undefined): string | null {
  if (!span) return null
  const text = facts.words
    .slice(span.start, span.end + 1)
    .map((w) => w.text.trim())
    .filter(Boolean)
    .join(' ')
  return text || null
}

// --- per-structure recipes --------------------------------------------

const QUOTE_CARD_HOLD_SEC = 0.6
const QUOTE_BAR_POS = { x: 0.5, y: 0.15, align: 'center' as const }
const CHAT_BUBBLE_POS = { x: 0.5, y: 0.22, align: 'center' as const }
const CHAT_BUBBLE_DURATION = 1.4
const CHAT_BUBBLE_MIN_SPACING = 2.5
const CHAT_BUBBLE_MAX_COUNT = 3

interface Recipe {
  segments: EdlSegment[]
  freeze: FreezeCue[]
  overlays: OverlayCue[]
  sfx: SfxCue[]
  zoom: ZoomKeyframe[]
  ending: Ending
}

function finish(r: Recipe): Edl {
  return { segments: r.segments, zoom: r.zoom, freeze: r.freeze, overlays: r.overlays, sfx: r.sfx, ending: r.ending }
}

/** `options.envelope` here is already clip-relative (see `buildViralEdit`). */
function pacingContext(options: ViralEditOptions, tight: boolean): PacingContext {
  return { env: options.envelope ?? null, tight, plain: options.plain === true, loopEndSec: options.loop?.endSec ?? null }
}

/** The shared "nothing special, just the house look" shape every recipe starts from. */
function plainRecipe(words: Word[], clipLength: number, peakSrcT: number, options: ViralEditOptions, tight = false): { segments: EdlSegment[]; freeze: FreezeCue[] } {
  return { segments: trimSilences(words, clipLength, peakSrcT, pacingContext(options, tight)).segments, freeze: [] }
}

/** A loop is a property of a version, not of a structure: it is there when the rule engine passed one in (`options.loop`), whatever the structure. */
function endingFor(options: ViralEditOptions): Ending {
  return options.loop ? { kind: 'loop', crossfadeSec: options.loop.crossfadeSec } : { kind: 'cut' }
}

function tightCutEdl(words: Word[], clipLength: number, peakSrcT: number, options: ViralEditOptions): Edl {
  const { segments, freeze } = plainRecipe(words, clipLength, peakSrcT, options)
  const peakOut = srcToOutput(segments, freeze, peakSrcT, true)
  const mainDuration = concatDuration(segments)
  return finish({ segments, freeze, overlays: [], sfx: boomCue(peakOut, options), zoom: snapZoomAtPeak(peakOut, mainDuration), ending: endingFor(options) })
}

function quoteCardEdl(decision: StructureDecision, facts: ClipFacts, words: Word[], clipLength: number, peakSrcT: number, options: ViralEditOptions): Edl {
  const text = spanText(facts, decision.quoteSpan)
  const { segments } = plainRecipe(words, clipLength, peakSrcT, options)
  const freeze: FreezeCue[] = []
  const overlays: OverlayCue[] = []
  let sfx: SfxCue[] = []

  if (text) {
    freeze.push({ atOutputT: 0, holdSec: QUOTE_CARD_HOLD_SEC })
    overlays.push({ kind: 'quoteBar', t0: 0, t1: QUOTE_CARD_HOLD_SEC, text, pos: QUOTE_BAR_POS })
    sfx = popCue(0, options)
  }

  const peakOut = srcToOutput(segments, freeze, peakSrcT, true)
  const mainDuration = concatDuration(segments) + freezeTotal(freeze)
  return finish({
    segments,
    freeze,
    overlays,
    sfx: [...sfx, ...boomCue(peakOut, options)],
    zoom: snapZoomAtPeak(peakOut, mainDuration),
    ending: endingFor(options)
  })
}

function buildAndPunchEdl(words: Word[], clipLength: number, peakSrcT: number, options: ViralEditOptions): Edl {
  const { segments, freeze } = plainRecipe(words, clipLength, peakSrcT, options)
  const setupOut = srcToOutput(segments, freeze, 0, false)
  const peakOut = srcToOutput(segments, freeze, peakSrcT, true)
  const mainDuration = concatDuration(segments)
  return finish({ segments, freeze, overlays: [], sfx: boomCue(peakOut, options), zoom: pushThenSnapZoom(setupOut, peakOut, mainDuration), ending: endingFor(options) })
}

function chatFirstEdl(decision: StructureDecision, facts: ClipFacts, words: Word[], clipLength: number, peakSrcT: number, options: ViralEditOptions): Edl {
  const { segments, freeze } = plainRecipe(words, clipLength, peakSrcT, options)
  const mainDuration = concatDuration(segments)

  const raw = (decision.chatMessageIds ?? [])
    .map((i) => facts.chatMessages[i])
    .filter((m): m is ChatMessage => !!m && m.text.trim().length > 0)
    .map((m) => ({ text: m.text, t: m.t - facts.window.start }))
    .filter((m) => m.t >= 0 && m.t < clipLength)
    .sort((a, b) => a.t - b.t)

  const cappedTimes = capTimeDensity(raw.map((b) => b.t), clipLength, CHAT_BUBBLE_MIN_SPACING, Math.min(raw.length, CHAT_BUBBLE_MAX_COUNT))
  const overlays: OverlayCue[] = []
  let sfx: SfxCue[] = []
  for (const srcT of cappedTimes) {
    const bubble = raw.find((b) => b.t === srcT)!
    const t0 = srcToOutput(segments, freeze, srcT, true)
    const t1 = Math.min(mainDuration, t0 + CHAT_BUBBLE_DURATION)
    if (t1 <= t0) continue
    overlays.push({ kind: 'chatBubble', t0, t1, text: bubble.text, pos: CHAT_BUBBLE_POS })
    sfx = [...sfx, ...popCue(t0, options)]
  }

  const peakOut = srcToOutput(segments, freeze, peakSrcT, true)
  return finish({ segments, freeze, overlays, sfx: [...sfx, ...boomCue(peakOut, options)], zoom: snapZoomAtPeak(peakOut, mainDuration), ending: endingFor(options) })
}

function rapidFireEdl(signals: StructureSignals, words: Word[], clipLength: number, peakSrcT: number, options: ViralEditOptions): Edl {
  const { segments, freeze } = plainRecipe(words, clipLength, peakSrcT, options, true)
  const mainDuration = concatDuration(segments)
  const candidates = signals.subPeakTimes.length > 0 ? signals.subPeakTimes : [peakSrcT]
  const cappedSrc = capTimeDensity(candidates, clipLength, ZOOM_MIN_SPACING_SEC, maxZoomCount(clipLength))
  const outputs = cappedSrc.map((t) => srcToOutput(segments, freeze, t, true))
  // Sparingly: only the strongest (earliest-detected) sub-peak gets a boom, not every one.
  const sfx = outputs.length > 0 ? boomCue(outputs[0]!, options) : []
  return finish({ segments, freeze, overlays: [], sfx, zoom: burstZoomKeyframes(outputs, mainDuration), ending: endingFor(options) })
}

/**
 * The straight edit's result plus what the pacing pass did. `options.envelope`
 * (VOD seconds) falls back to the job's per-second loudness in `facts`; the
 * result always fits inside the original clip's length plus a short freeze --
 * every recipe only trims and reorders, it never stretches the clip out.
 *
 * `payoffFirst` (the peak is already in the first 15% of the clip, under 3 s of
 * setup) is a tight cut: the clip already opens on its payoff, so replaying
 * the payoff as a cold open would show the same words twice within a couple of
 * seconds. The cold open proper is a separate version of a clip with a real
 * setup, planned by `coldOpen.ts` and built by `coldOpenVariantEdl`.
 */
export function buildViralEdit(decision: StructureDecision, facts: ClipFacts, options: ViralEditOptions = {}): { edl: Edl; stats: PacingStats } {
  const signals = computeSignals(facts)
  const clipLength = signals.clipLength
  const words = clipRelativeWords(facts)
  const peakSrcT = clamp(signals.setupLength, 0, clipLength)
  const env = shiftEnvelope(options.envelope ?? envelopeFromLoudness(facts.loudness, facts.loudnessOffset), facts.window.start)
  const local: ViralEditOptions = { ...options, envelope: env }

  let edl: Edl
  switch (decision.structure) {
    case 'quoteCard':
      edl = quoteCardEdl(decision, facts, words, clipLength, peakSrcT, local)
      break
    case 'buildAndPunch':
      edl = buildAndPunchEdl(words, clipLength, peakSrcT, local)
      break
    case 'chatFirst':
      edl = chatFirstEdl(decision, facts, words, clipLength, peakSrcT, local)
      break
    case 'rapidFire':
      edl = rapidFireEdl(signals, words, clipLength, peakSrcT, local)
      break
    case 'payoffFirst':
    case 'freezeLoop':
    case 'tightCut':
    default:
      edl = tightCutEdl(words, clipLength, peakSrcT, local)
      break
  }
  // The same pass again, only for its numbers (cheap and deterministic).
  const stats = trimSilences(words, clipLength, peakSrcT, pacingContext(local, decision.structure === 'rapidFire')).stats
  return { edl, stats }
}

export function buildViralEdl(decision: StructureDecision, facts: ClipFacts, options: ViralEditOptions = {}): Edl {
  return buildViralEdit(decision, facts, options).edl
}

/**
 * The cold-open version of an already built straight edit: the plan's preview
 * (payoff plus its reaction) in front, a whoosh on the join, and everything
 * else -- segments, zoom, freezes, overlays, sound effects -- pushed later by
 * the preview's length. The return is a hard cut back to the start of the
 * straight edit. Always a plain cut ending: a loop needs the same first and
 * last frame, and this version starts on the preview instead.
 */
export function coldOpenVariantEdl(straight: Edl, plan: ColdOpenPlan, options: ViralEditOptions = {}): Edl | null {
  if (!plan.qualifies || plan.segments.length === 0) return null
  const preview: EdlSegment = { srcStart: plan.segments[0]!.srcStart, srcEnd: plan.segments[0]!.srcEnd, speed: 1 }
  const len = segmentDuration(preview)
  return {
    segments: [preview, ...straight.segments],
    zoom: [{ t: 0, scale: 1, ease: 'snap' }, ...straight.zoom.map((z) => ({ ...z, t: z.t + len }))],
    freeze: straight.freeze.map((f) => ({ ...f, atOutputT: f.atOutputT + len })),
    overlays: straight.overlays.map((o) => ({ ...o, t0: o.t0 + len, t1: o.t1 + len })),
    sfx: [...whooshCue(len, options), ...straight.sfx.map((s) => ({ ...s, t: s.t + len }))],
    ending: { kind: 'cut' }
  }
}
