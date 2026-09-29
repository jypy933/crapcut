// Turns one accepted clip's structure decision (`structurePick.ts`) into a
// full re-edit: the one evidence-based "house look" (silences trimmed but the
// pre-punchline pause kept, a single snap punch-in zoom on the peak, sound
// effects used sparingly, a loop ending where the structure calls for one)
// applied through a small per-structure recipe. Pure: no I/O, no FFmpeg.
// `edlFilter.ts` turns the result into a filter graph and `edlCaptions.ts`
// remaps the clip's own words onto it; nothing here invents on-screen text --
// a quote card or chat bubble only ever repeats the clip's own words or a
// real chat message.
//
// `buildViralEdl` only takes the structure decision, the clip's facts and the
// SFX file paths: everything else (where the peak sits, how much build-up
// there is, the sub-peaks) is recomputed from `computeSignals(facts)`, the
// same pure function `structurePick.ts` used to make the decision in the
// first place, so the two are always consistent with each other.

import type { ChatMessage, Word } from '@shared/types'
import type { Edl, EdlSegment, Ending, FreezeCue, OverlayCue, SfxCue, ZoomKeyframe } from './edl'
import { concatDuration, concatToOutputTime, freezeTotal, mapSourceTimeToConcat, segmentDuration } from './edl'
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
}

const clamp = (n: number, lo: number, hi: number): number => Math.max(lo, Math.min(hi, n))

// --- silence trimming -------------------------------------------------

/** A gap shorter than this is normal speech pacing and is left alone. */
const TRIM_GAP_THRESHOLD = 0.5
/** A gap this small is what a trimmed silence is cut down to (0.1-0.25 s). */
const TRIM_TARGET = 0.18
/** rapidFire's tighter version of the same two constants. */
const TIGHT_GAP_THRESHOLD = 0.35
const TIGHT_TRIM_TARGET = 0.12
/** The pause right before the peak/punchline is kept, up to this long (0.3-0.6 s). */
const PRE_PEAK_MAX_KEEP = 0.6
/** A little natural air kept before the first word and after the last, so a cut does not clip a word's onset. */
const EDGE_PADDING = 0.15

/** The last gap between two words that sits entirely before `peakSrcT`, or -1 with none. */
function findPrePeakGapIndex(words: Word[], peakSrcT: number): number {
  let idx = -1
  for (let i = 0; i < words.length - 1; i++) {
    if (words[i + 1]!.t0 <= peakSrcT) idx = i
    else break
  }
  return idx
}

/**
 * Base pass shared by every structure: cuts dead air between words down to a
 * short trim, except the one pause right before the peak, which is left
 * alone up to `PRE_PEAK_MAX_KEEP` (only a longer one gets capped, never
 * stretched -- there is no audio to invent). With no words at all (a
 * transcript-free degraded clip) the whole clip is kept as one segment.
 */
function trimSilences(words: Word[], clipLength: number, peakSrcT: number, tight: boolean): EdlSegment[] {
  if (words.length === 0 || clipLength <= 0) return [{ srcStart: 0, srcEnd: Math.max(0.05, clipLength), speed: 1 }]

  const threshold = tight ? TIGHT_GAP_THRESHOLD : TRIM_GAP_THRESHOLD
  const target = tight ? TIGHT_TRIM_TARGET : TRIM_TARGET
  const prePeakGap = findPrePeakGapIndex(words, peakSrcT)

  const segments: EdlSegment[] = []
  let segStart = Math.max(0, words[0]!.t0 - EDGE_PADDING)
  for (let i = 0; i < words.length - 1; i++) {
    const w = words[i]!
    const next = words[i + 1]!
    const gap = next.t0 - w.t1
    const isPrePeak = i === prePeakGap
    const cutAbove = isPrePeak ? PRE_PEAK_MAX_KEEP : threshold
    if (gap <= cutAbove) continue
    const keep = isPrePeak ? PRE_PEAK_MAX_KEEP : target
    const segEnd = w.t1 + keep / 2
    segments.push({ srcStart: segStart, srcEnd: Math.max(segStart + 0.02, segEnd), speed: 1 })
    segStart = Math.max(segEnd, next.t0 - keep / 2)
  }
  const lastEnd = clamp(words[words.length - 1]!.t1 + EDGE_PADDING, segStart + 0.05, clipLength)
  segments.push({ srcStart: segStart, srcEnd: lastEnd, speed: 1 })
  return segments
}

// --- source time -> output time ----------------------------------------

/** The nearest point in any segment's source range to `srcT` (for a time that fell in a trimmed gap). */
function nearestSegmentClamp(segments: readonly EdlSegment[], srcT: number): number {
  let best = segments[0]!.srcStart
  let bestDist = Infinity
  for (const s of segments) {
    const c = clamp(srcT, s.srcStart, s.srcEnd)
    const dist = Math.abs(c - srcT)
    if (dist < bestDist) {
      bestDist = dist
      best = c
    }
  }
  return best
}

/**
 * Where a source-clip second lands on the final output timeline, after
 * segment reordering/trimming and any freezes. `useLast` picks the later
 * occurrence when a segment is reused (a cold open replays part of the
 * clip): the real payoff, not the flashed-forward hook. A source time inside
 * a trimmed-out gap is clamped to the nearest kept moment instead of being
 * dropped, so a cue never silently disappears.
 */
function srcToOutput(segments: readonly EdlSegment[], freeze: readonly FreezeCue[], srcT: number, useLast: boolean): number {
  const concatTimes = mapSourceTimeToConcat(segments, srcT)
  const concatT = concatTimes.length > 0 ? concatTimes[useLast ? concatTimes.length - 1 : 0]! : mapSourceTimeToConcat(segments, nearestSegmentClamp(segments, srcT))[0] ?? 0
  return concatToOutputTime(freeze, concatT)
}

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

// --- the loop ending ------------------------------------------------------

const LOOP_INTRO_MAX = 1.4
const LOOP_CROSSFADE_RATIO = 0.65

/** A short, seamless loop back to the start -- "no longer than the clip plus a short freeze". */
function loopEndingFor(mainDuration: number): Ending {
  const cap = Math.max(0.1, mainDuration)
  const introSec = Math.min(LOOP_INTRO_MAX, cap, Math.max(0.3, mainDuration * 0.3))
  const crossfadeSec = Math.max(0.05, Math.min(introSec - 0.05, introSec * LOOP_CROSSFADE_RATIO))
  return { kind: 'loop', introSec, crossfadeSec }
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
function clipRelativeWords(facts: ClipFacts): Word[] {
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

/** The shared "nothing special, just the house look" shape every recipe starts from. */
function plainRecipe(words: Word[], clipLength: number, peakSrcT: number, tight = false): { segments: EdlSegment[]; freeze: FreezeCue[] } {
  return { segments: trimSilences(words, clipLength, peakSrcT, tight), freeze: [] }
}

function tightCutEdl(words: Word[], clipLength: number, peakSrcT: number, options: ViralEditOptions): Edl {
  const { segments, freeze } = plainRecipe(words, clipLength, peakSrcT)
  const peakOut = srcToOutput(segments, freeze, peakSrcT, true)
  const mainDuration = concatDuration(segments)
  return finish({ segments, freeze, overlays: [], sfx: boomCue(peakOut, options), zoom: snapZoomAtPeak(peakOut, mainDuration), ending: { kind: 'cut' } })
}

function payoffFirstEdl(decision: StructureDecision, words: Word[], clipLength: number, peakSrcT: number, options: ViralEditOptions): Edl {
  const cold = decision.coldOpenSpan
  if (!cold || cold.end <= cold.start) return tightCutEdl(words, clipLength, peakSrcT, options)

  const coldSeg: EdlSegment = { srcStart: clamp(cold.start, 0, clipLength), srcEnd: clamp(cold.end, 0, clipLength), speed: 1 }
  const { segments: buildUp } = plainRecipe(words, clipLength, peakSrcT)
  const segments = [coldSeg, ...buildUp]
  const freeze: FreezeCue[] = []

  const whooshOut = concatToOutputTime(freeze, segmentDuration(coldSeg))
  const peakOut = srcToOutput(segments, freeze, peakSrcT, true)
  const mainDuration = concatDuration(segments)
  return finish({
    segments,
    freeze,
    overlays: [],
    sfx: [...whooshCue(whooshOut, options), ...boomCue(peakOut, options)],
    zoom: snapZoomAtPeak(peakOut, mainDuration),
    ending: { kind: 'cut' }
  })
}

function quoteCardEdl(decision: StructureDecision, facts: ClipFacts, words: Word[], clipLength: number, peakSrcT: number, options: ViralEditOptions): Edl {
  const text = spanText(facts, decision.quoteSpan)
  const { segments } = plainRecipe(words, clipLength, peakSrcT)
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
    ending: decision.loopEnding ? loopEndingFor(mainDuration) : { kind: 'cut' }
  })
}

function buildAndPunchEdl(words: Word[], clipLength: number, peakSrcT: number, options: ViralEditOptions): Edl {
  const { segments, freeze } = plainRecipe(words, clipLength, peakSrcT)
  const setupOut = srcToOutput(segments, freeze, 0, false)
  const peakOut = srcToOutput(segments, freeze, peakSrcT, true)
  const mainDuration = concatDuration(segments)
  return finish({ segments, freeze, overlays: [], sfx: boomCue(peakOut, options), zoom: pushThenSnapZoom(setupOut, peakOut, mainDuration), ending: { kind: 'cut' } })
}

function chatFirstEdl(decision: StructureDecision, facts: ClipFacts, words: Word[], clipLength: number, peakSrcT: number, options: ViralEditOptions): Edl {
  const { segments, freeze } = plainRecipe(words, clipLength, peakSrcT)
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
  return finish({ segments, freeze, overlays, sfx: [...sfx, ...boomCue(peakOut, options)], zoom: snapZoomAtPeak(peakOut, mainDuration), ending: { kind: 'cut' } })
}

function rapidFireEdl(signals: StructureSignals, words: Word[], clipLength: number, peakSrcT: number, options: ViralEditOptions): Edl {
  const { segments, freeze } = plainRecipe(words, clipLength, peakSrcT, true)
  const mainDuration = concatDuration(segments)
  const candidates = signals.subPeakTimes.length > 0 ? signals.subPeakTimes : [peakSrcT]
  const cappedSrc = capTimeDensity(candidates, clipLength, ZOOM_MIN_SPACING_SEC, maxZoomCount(clipLength))
  const outputs = cappedSrc.map((t) => srcToOutput(segments, freeze, t, true))
  // Sparingly: only the strongest (earliest-detected) sub-peak gets a boom, not every one.
  const sfx = outputs.length > 0 ? boomCue(outputs[0]!, options) : []
  return finish({ segments, freeze, overlays: [], sfx, zoom: burstZoomKeyframes(outputs, mainDuration), ending: { kind: 'cut' } })
}

function freezeLoopEdl(words: Word[], clipLength: number, peakSrcT: number, options: ViralEditOptions): Edl {
  const { segments, freeze } = plainRecipe(words, clipLength, peakSrcT)
  const peakOut = srcToOutput(segments, freeze, peakSrcT, true)
  const mainDuration = concatDuration(segments)
  return finish({ segments, freeze, overlays: [], sfx: boomCue(peakOut, options), zoom: snapZoomAtPeak(peakOut, mainDuration), ending: loopEndingFor(mainDuration) })
}

/**
 * Builds the one house-look re-edit for an accepted clip. `decision` picks
 * the structure (`structurePick.ts`); `facts` is the same clip evidence
 * `computeSignals` (and so the decision) was built from. The result always
 * fits inside the original clip's length plus a short freeze or loop tail --
 * every recipe only trims and reorders, it never stretches the clip out.
 */
export function buildViralEdl(decision: StructureDecision, facts: ClipFacts, options: ViralEditOptions = {}): Edl {
  const signals = computeSignals(facts)
  const clipLength = signals.clipLength
  const words = clipRelativeWords(facts)
  const peakSrcT = clamp(signals.setupLength, 0, clipLength)

  switch (decision.structure) {
    case 'payoffFirst':
      return payoffFirstEdl(decision, words, clipLength, peakSrcT, options)
    case 'quoteCard':
      return quoteCardEdl(decision, facts, words, clipLength, peakSrcT, options)
    case 'buildAndPunch':
      return buildAndPunchEdl(words, clipLength, peakSrcT, options)
    case 'chatFirst':
      return chatFirstEdl(decision, facts, words, clipLength, peakSrcT, options)
    case 'rapidFire':
      return rapidFireEdl(signals, words, clipLength, peakSrcT, options)
    case 'freezeLoop':
      return freezeLoopEdl(words, clipLength, peakSrcT, options)
    case 'tightCut':
    default:
      return tightCutEdl(words, clipLength, peakSrcT, options)
  }
}
