// The auto edit's rules, in one place. Every threshold is a starting value from
// the research table in `docs/auto-edit-research.md` (section 4.7), approved by
// the owner and meant to be tuned on real clips: change a number here and
// nothing else. The checks themselves are pure functions over a clip's words,
// loudness and edit; each returns a `CheckResult` that
// `formatCheckLine` turns into the one compact log line per check and clip.
// The results only ever go to the local log file, never to the UI.

import type { Word } from '@shared/types'
import { FINAL_FLOOR_SEC, PLATFORMS, type Platform, type PlatformCapFit } from '@shared/editPlan'
import { concatDuration, type Edl, type EdlSegment } from './edl'

export const EDIT_RULES = {
  length: {
    /** The floor applies to the FINAL edited length, not the source window (`CLIP_MIN_SEC` in moments.ts stays the window minimum). */
    finalFloorSec: FINAL_FLOOR_SEC,
    targetMinSec: 15,
    targetMaxSec: 45,
    /** Product caps, not platform limits (those are 10-60 min, 3 min, 3 min). */
    capSec: { tiktok: 60, shorts: 60, reels: 90 } satisfies Record<Platform, number>
  },
  content: {
    minChatPeaks: 1,
    /** A chat second counts as a peak from this much distinct-chatter reaction weight (about three different people reacting). */
    chatPeakMinWeight: 3,
    /** Words plus loud frames must cover this share of the final edit. */
    minCoverage: 0.4,
    /** A frame is loud enough to count as content when it is within this many dB of the clip's median. */
    coverageBelowMedianDb: 15
  },
  hook: {
    softSec: 0.5,
    hardSec: 1.0,
    /** Leading silence over this is trimmed... */
    trimOverSec: 0.3,
    /** ...down to this. Whisper's onset error is up to about 135 ms, so less would clip a word. */
    keepSec: 0.15,
    /** A frame this far above the clip's median dB counts as a reaction (a shout, a laugh) when there are no words. */
    reactionAboveMedianDb: 3
  },
  pacing: {
    pauseSec: 0.5,
    /** A pause with loud game sound in it is not dead air. */
    loudGamePauseSec: 0.7,
    /** rapidFire's tighter trigger. */
    tightPauseSec: 0.4,
    /** A cut pause is kept at this length: at least `minSideSec` on each side, since word ends sit about 100 ms early. */
    keepGapSec: 0.3,
    minSideSec: 0.15,
    /** The pause right before the payoff is kept whole, up to this long. */
    prePeakMaxKeepSec: 0.6,
    /** Game sound counts as loud in a gap when it is within this many dB of the speech level. */
    loudGameMarginDb: 6,
    /** The loud-game check needs an envelope at least this fine; a coarser one cannot tell a gap from the words beside it. */
    fineEnvelopeMaxStepSec: 0.25,
    /** The beat after the payoff that is never trimmed (0.5-1 s; the loud reaction frames extend it). */
    reactionBeatMinSec: 0.5,
    /** The edit ends this long after the reaction (1-2 s; the shorter end is used, the clip's own end permitting). */
    endAfterReactionSec: 1.0,
    /** How far past the payoff a loud reaction still counts as part of it. */
    reactionSearchSec: 4
  },
  coldOpen: {
    setupMinSec: 8,
    /** Skip when the payoff is already inside the first seconds or the first share of the clip. */
    skipPayoffFirstSec: 3,
    skipPayoffFirstRatio: 0.15,
    previewMinSec: 1.5,
    previewPreferredMaxSec: 3,
    previewMaxSec: 4,
    /** The preview is at most this share of the straight edit. */
    maxShareOfClip: 0.2,
    /** Seconds of lead-in before the payoff words, so the punchline's first word is not clipped. */
    previewLeadSec: 0.6,
    previewTailSec: 1.5,
    noRepeatWithinSec: 2,
    /** How far apart (seconds) the chat and loudness peaks may be and still count as the same event; chat lags the audio, see `chatDelaySec`. */
    agreeToleranceSec: 8,
    chatDelaySec: 7,
    /** The payoff's loudness must stand this far above the clip's median dB. */
    loudPeakMinAboveMedianDb: 6,
    /** Words that must sit in the preview for the transcript to back it. */
    minPreviewWords: 3,
    weights: { chat: 0.4, loud: 0.35, words: 0.25 },
    /** With the local LLM confirming, this confidence is enough... */
    minConfidenceWithLlm: 0.55,
    /** ...without it the deterministic gate is stricter. */
    minConfidenceNoLlm: 0.7
  },
  loop: {
    maxFinalSec: 30,
    quietMinSec: 0.15,
    quietMaxSec: 0.4,
    quietTargetSec: 0.25,
    /** Whisper's word ends sit about this early (docs/auto-edit-research.md). */
    wordEndEarlySec: 0.1,
    /** Uncalibrated: no real clip has been measured against it yet. */
    minFrameSimilarity: 0.55,
    /** A mean grey-level difference of this many levels (of 255) scores a frame similarity of 0. */
    frameDiffFullScale: 64,
    maxLoudnessDiffLu: 3,
    loudnessWindowSec: 0.4,
    crossfadeMinSec: 0.03,
    crossfadeMaxSec: 0.1,
    crossfadeSec: 0.06
  }
} as const

// --- the audio envelope ----------------------------------------------------

/** Loudness over time: `db[i]` covers [startSec + i*stepSec, +stepSec). VOD seconds. */
export interface Envelope {
  startSec: number
  stepSec: number
  db: number[]
}

/** The job's per-second loudness log as an envelope, or null when it is missing. */
export function envelopeFromLoudness(loudness: Float64Array | number[] | null | undefined, offsetSec = 0): Envelope | null {
  if (!loudness || loudness.length === 0) return null
  return { startSec: offsetSec, stepSec: 1, db: Array.from(loudness) }
}

/** Mean-square level in dB of each `stepSec` block of mono samples (-100 for digital silence). */
export function envelopeFromSamples(samples: Float32Array, sampleRate: number, stepSec: number, startSec: number): Envelope {
  const block = Math.max(1, Math.round(stepSec * sampleRate))
  const db: number[] = []
  for (let i = 0; i + block <= samples.length; i += block) {
    let sum = 0
    for (let j = i; j < i + block; j++) sum += samples[j]! * samples[j]!
    const ms = sum / block
    db.push(ms > 1e-10 ? Math.max(-100, 10 * Math.log10(ms)) : -100)
  }
  return { startSec, stepSec, db }
}

/**
 * The envelope as the job's one-value-per-second loudness log: the power mean
 * of each whole second, so `computeSignals` finds the same peak it does from
 * `loudness.txt`. Index 0 is the second starting at `env.startSec`.
 */
export function perSecondLoudness(env: Envelope): Float64Array {
  const perSecond = Math.max(1, Math.round(1 / env.stepSec))
  const out = new Float64Array(Math.floor(env.db.length / perSecond))
  for (let i = 0; i < out.length; i++) {
    let power = 0
    for (let k = 0; k < perSecond; k++) power += Math.pow(10, env.db[i * perSecond + k]! / 10)
    out[i] = 10 * Math.log10(power / perSecond)
  }
  return out
}

const isFinite_ = (n: number): boolean => Number.isFinite(n)

/** The dB of the frame holding second `t` (the envelope's own clock), or null outside it. */
export function dbAt(env: Envelope, t: number): number | null {
  const i = Math.floor((t - env.startSec) / env.stepSec + 1e-9)
  return i >= 0 && i < env.db.length ? env.db[i]! : null
}

/** dB values of the frames overlapping [from, to] (VOD seconds). */
function framesIn(env: Envelope, from: number, to: number): number[] {
  const lo = Math.max(0, Math.floor((from - env.startSec) / env.stepSec))
  const hi = Math.min(env.db.length - 1, Math.ceil((to - env.startSec) / env.stepSec) - 1)
  const out: number[] = []
  for (let i = lo; i <= hi; i++) out.push(env.db[i]!)
  return out
}

export function median(values: number[]): number | null {
  const v = values.filter(isFinite_).sort((a, b) => a - b)
  if (v.length === 0) return null
  const mid = v.length >> 1
  return v.length % 2 ? v[mid]! : (v[mid - 1]! + v[mid]!) / 2
}

/** The median dB of the frames in [from, to] that are not near-silent, or null with none. */
export function medianDb(env: Envelope | null, from: number, to: number): number | null {
  return env ? median(framesIn(env, from, to).filter((d) => d > -60)) : null
}

/** The loudest frame in [from, to], or -Infinity with no coverage. */
export function maxDb(env: Envelope, from: number, to: number): number {
  return framesIn(env, from, to).reduce((m, d) => Math.max(m, d), -Infinity)
}

/**
 * The speech level: the median dB of frames that overlap a word. Game sound
 * is "loud" in a gap when it comes within `loudGameMarginDb` of this. Null with
 * no words or no envelope (a coarse envelope's frames mix speech and gap, so
 * the loud-game rule is left off, see `fineEnvelopeMaxStepSec`).
 */
export function speechFloorDb(env: Envelope | null, words: Word[]): number | null {
  if (!env || env.stepSec > EDIT_RULES.pacing.fineEnvelopeMaxStepSec || words.length === 0) return null
  const levels: number[] = []
  for (const w of words) levels.push(...framesIn(env, w.t0, w.t1))
  const speech = median(levels.filter((d) => d > -60))
  return speech === null ? null : speech - EDIT_RULES.pacing.loudGameMarginDb
}

/** True when game (non-speech) sound in the gap [t0, t1] is loud enough that the pause is not dead air. Times in the envelope's clock. */
export function isLoudGap(env: Envelope | null, floorDb: number | null, t0: number, t1: number): boolean {
  if (!env || floorDb === null || env.stepSec > EDIT_RULES.pacing.fineEnvelopeMaxStepSec) return false
  // Shrunk a little so the words either side do not count as game sound.
  const margin = env.stepSec
  if (t1 - t0 <= 2 * margin) return false
  return maxDb(env, t0 + margin, t1 - margin) >= floorDb
}

// --- results and log lines ----------------------------------------------------

export type CheckValue = number | string | boolean | null

export interface CheckResult {
  /** Short stable id, e.g. `length`, `content`, `hook`, `pacing`, `coldOpen`, `loop`. */
  check: string
  /** `pass`, `fail`, or `na` when the check had nothing to measure (no chat, no envelope). */
  status: 'pass' | 'fail' | 'na'
  values: Record<string, CheckValue>
}

function fmt(v: CheckValue): string {
  if (typeof v === 'number') return Number.isInteger(v) ? String(v) : v.toFixed(2)
  return String(v)
}

/** One compact line for the local log: `rule length clip=ab12cd34 pass final=23.40 floor=10 ...`. */
export function formatCheckLine(clipTag: string, r: CheckResult): string {
  const vals = Object.entries(r.values)
    .map(([k, v]) => `${k}=${fmt(v)}`)
    .join(' ')
  return `rule ${r.check} clip=${clipTag} ${r.status}${vals ? ` ${vals}` : ''}`
}

// --- length ----------------------------------------------------------------------

/** How each platform's product cap holds for a final length. */
export function capFit(finalSec: number): PlatformCapFit {
  const out = {} as PlatformCapFit
  for (const p of PLATFORMS) out[p] = { capSec: EDIT_RULES.length.capSec[p], fits: finalSec <= EDIT_RULES.length.capSec[p] + 1e-6 }
  return out
}

export function checkLength(finalSec: number, extras: { editSkipped: boolean; extendedSec: number }): CheckResult {
  const { finalFloorSec, targetMinSec, targetMaxSec } = EDIT_RULES.length
  const fit = capFit(finalSec)
  return {
    check: 'length',
    status: finalSec >= finalFloorSec - 1e-6 ? 'pass' : 'fail',
    values: {
      final: finalSec,
      floor: finalFloorSec,
      inTarget: finalSec >= targetMinSec && finalSec <= targetMaxSec,
      skippedEdit: extras.editSkipped,
      extended: extras.extendedSec,
      fitsTiktok: fit.tiktok.fits,
      fitsShorts: fit.shorts.fits,
      fitsReels: fit.reels.fits
    }
  }
}

// --- content floor -------------------------------------------------------------------

/**
 * The share of the final edit that is speech or loud, in [0, 1]. A "loud
 * frame" is one within `coverageBelowMedianDb` of the clip's median; frames
 * and words are unioned inside each segment so overlap is counted once.
 * `words` and `env` are in the same clock as the segments (both clip-relative
 * here: callers shift the envelope with `shiftEnvelope`).
 */
export function contentCoverage(segments: readonly EdlSegment[], words: Word[], env: Envelope | null, windowSec: { from: number; to: number }): number {
  const total = concatDuration(segments)
  if (total <= 0) return 0
  const floor = env ? (medianDb(env, windowSec.from, windowSec.to) ?? null) : null
  const loudBelow = floor === null ? null : floor - EDIT_RULES.content.coverageBelowMedianDb

  let covered = 0
  for (const seg of segments) {
    const intervals: [number, number][] = []
    for (const w of words) {
      const a = Math.max(w.t0, seg.srcStart)
      const b = Math.min(w.t1, seg.srcEnd)
      if (b > a) intervals.push([a, b])
    }
    if (env && loudBelow !== null) {
      for (let i = 0; i < env.db.length; i++) {
        if (env.db[i]! < loudBelow) continue
        const a = Math.max(env.startSec + i * env.stepSec, seg.srcStart)
        const b = Math.min(env.startSec + (i + 1) * env.stepSec, seg.srcEnd)
        if (b > a) intervals.push([a, b])
      }
    }
    intervals.sort((x, y) => x[0] - y[0])
    let curEnd = -Infinity
    let sum = 0
    for (const [a, b] of intervals) {
      const from = Math.max(a, curEnd)
      if (b > from) sum += b - from
      curEnd = Math.max(curEnd, b)
    }
    covered += sum / seg.speed
  }
  return Math.min(1, covered / total)
}

export function shiftEnvelope(env: Envelope | null, byNegSec: number): Envelope | null {
  return env ? { ...env, startSec: env.startSec - byNegSec } : null
}

/** Chat peaks in a per-second distinct-chatter series (clip-relative): local maxima at or above the minimum weight, at least 5 s apart. */
export function countChatPeaks(series: Float64Array | null): number {
  if (!series) return 0
  const min = EDIT_RULES.content.chatPeakMinWeight
  const peaks: number[] = []
  for (let i = 0; i < series.length; i++) {
    const v = series[i]!
    if (v < min) continue
    if ((i > 0 && v < series[i - 1]!) || (i < series.length - 1 && v <= series[i + 1]!)) continue
    if (peaks.some((p) => Math.abs(p - i) < 5)) continue
    peaks.push(i)
  }
  return peaks.length
}

/**
 * A strong loudness peak (`loudPeak`, the bar moment finding uses) stands in for
 * the chat peak: loud moments were picked for a reason and are never dropped
 * for lacking chat or speech. A moment found from the transcript alone
 * (`transcriptMoment`) has no chat peak by construction, so it satisfies that
 * half too; the coverage half still applies to it.
 */
export function checkContent(chatPeaks: number | null, coverage: number, loudPeak = false, transcriptMoment = false): CheckResult {
  const { minChatPeaks, minCoverage } = EDIT_RULES.content
  // With no chat replay at all the chat half cannot be judged; the coverage half still is.
  const chatOk = chatPeaks === null || loudPeak || transcriptMoment || chatPeaks >= minChatPeaks
  return {
    check: 'content',
    status: chatOk && coverage >= minCoverage ? 'pass' : 'fail',
    values: { chatPeaks, loudPeak, transcriptMoment, coverage, minCoverage }
  }
}

// --- hook ----------------------------------------------------------------------------------

/**
 * Clip-relative second of the first speech or reaction: the first word, or with
 * no words the first frame `reactionAboveMedianDb` over the clip's median.
 * Null when there is neither.
 */
export function firstEventSec(words: Word[], env: Envelope | null, window: { from: number; to: number }): number | null {
  if (words.length > 0) return Math.max(0, words[0]!.t0)
  if (!env) return null
  const floor = medianDb(env, window.from, window.to)
  if (floor === null) return null
  const above = floor + EDIT_RULES.hook.reactionAboveMedianDb
  for (let i = 0; i < env.db.length; i++) {
    const t = env.startSec + i * env.stepSec
    if (t + env.stepSec <= window.from) continue
    if (t >= window.to) break
    if (env.db[i]! >= above) return Math.max(0, t - window.from)
  }
  return null
}

/** Where the edit should start (clip-relative): 0, or `keepSec` before the first event when the lead-in is over `trimOverSec`. */
export function hookStartSec(firstEvent: number | null): number {
  if (firstEvent === null) return 0
  return firstEvent > EDIT_RULES.hook.trimOverSec ? Math.max(0, firstEvent - EDIT_RULES.hook.keepSec) : 0
}

/** Frame 0 is real content: the edit starts on a moving segment and no card or fade is put in front of it. */
export function frameZeroIsContent(edl: Edl): boolean {
  const first = edl.segments[0]
  if (!first || !(first.srcEnd > first.srcStart) || !(first.speed > 0)) return false
  return !edl.overlays.some((o) => o.t0 <= 0 && o.kind !== 'quoteBar')
}

export function checkHook(firstEventOutSec: number | null, frameZero: boolean): CheckResult {
  const { softSec, hardSec } = EDIT_RULES.hook
  let status: CheckResult['status'] = 'na'
  let grade = 'unknown'
  if (firstEventOutSec !== null) {
    grade = firstEventOutSec <= softSec ? 'soft' : firstEventOutSec <= hardSec ? 'hard' : 'late'
    status = firstEventOutSec <= hardSec && frameZero ? 'pass' : 'fail'
  } else if (!frameZero) status = 'fail'
  return { check: 'hook', status, values: { firstEvent: firstEventOutSec, grade, frameZeroContent: frameZero } }
}

// --- pacing -----------------------------------------------------------------------------------------

/** `stats` come from the pacing pass (`buildViralEdit`); the check also counts pauses still over the trigger inside a kept segment. */
export function checkPacing(edl: Edl, words: Word[], stats: { cuts: number; savedSec: number; minKeptGap: number | null; loudGapsKept: number }): CheckResult {
  let leftover = 0
  for (const seg of edl.segments) {
    const inside = words.filter((w) => w.t0 >= seg.srcStart - 1e-6 && w.t1 <= seg.srcEnd + 1e-6)
    for (let k = 0; k + 1 < inside.length; k++) if (inside[k + 1]!.t0 - inside[k]!.t1 > EDIT_RULES.pacing.loudGamePauseSec + 1e-6) leftover++
  }
  const keptOk = stats.minKeptGap === null || stats.minKeptGap >= 2 * EDIT_RULES.pacing.minSideSec - 1e-6
  return {
    check: 'pacing',
    status: keptOk ? 'pass' : 'fail',
    values: { cuts: stats.cuts, saved: stats.savedSec, minKeptGap: stats.minKeptGap, loudGapsKept: stats.loudGapsKept, pausesLeft: leftover }
  }
}
