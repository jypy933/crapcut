// Whether a clip can end as a seamless loop, and how good the seam is. A loop
// is a property of a version: it needs the final length to be 30 s or less, an
// end on the last word plus a short quiet, a first frame that looks like the
// last one, and speech at the end about as loud as speech at the start. The
// video is a hard cut and the audio is faded over 30-100 ms (see `Ending` in
// `edl.ts`); there is no end card. Pure: the frames and loudness are measured
// elsewhere (`pipeline/seamMeasure.ts`, FFmpeg at edit time) and scored here.
// Both thresholds were set on 80 real seams (docs/auto-edit-research.md, section 7).

import type { Rect, Word } from '@shared/types'
import { dbAt, EDIT_RULES, median, speechFloorDb, type CheckResult, type Envelope } from './editRules'
import { concatDuration, type EdlSegment } from './edl'

export interface LoopCandidate {
  /** Clip-relative second the looped edit ends at: the last word's real end plus its quiet. */
  endSec: number
  quietSec: number
  /** The quiet was read from a fine envelope; otherwise it is the target, not a measurement. */
  quietMeasured: boolean
  /** Where the last word's sound ends (clip-relative), just before the deliberate quiet. */
  speechEndSec: number
  /** Length of the looped edit. */
  finalSec: number
}

export interface LoopCandidateInputs {
  /** Clip-relative words. */
  words: Word[]
  /** Segments of the straight edit (clip-relative source seconds). */
  segments: EdlSegment[]
  clipLength: number
  /** The payoff, clip-relative: the reaction beat after it is never trimmed. */
  peakSec: number
  /** Clip-relative loudness, or null. */
  env: Envelope | null
}

/** Where a loop would end and why it cannot, without looking at any frame. */
export function planLoopEnd(inputs: LoopCandidateInputs): { candidate: LoopCandidate | null; reason: string | null } {
  const c = EDIT_RULES.loop
  const { words, segments, clipLength, peakSec, env } = inputs
  const last = words[words.length - 1]
  if (!last || segments.length === 0) return { candidate: null, reason: 'no words to end on' }

  const trueEnd = last.t1 + c.wordEndEarlySec
  const floorDb = speechFloorDb(env, words)
  let measured = false
  let quiet: number = c.quietTargetSec
  if (env && floorDb !== null) {
    // Quiet counted on the audio, not just from the word end: word ends sit early.
    measured = true
    quiet = 0
    for (let t = trueEnd; quiet < c.quietMaxSec; t += env.stepSec) {
      const db = dbAt(env, t)
      if (db === null || db > floorDb) break
      quiet += env.stepSec
    }
    if (quiet < c.quietMinSec) return { candidate: null, reason: `only ${quiet.toFixed(2)}s of quiet after the last word` }
  }
  const used = Math.min(quiet, c.quietTargetSec)
  const endSec = Math.min(clipLength, trueEnd + used)
  if (endSec - trueEnd < c.quietMinSec - 1e-6) return { candidate: null, reason: 'the clip ends right after the last word' }
  if (endSec < peakSec + EDIT_RULES.pacing.reactionBeatMinSec) return { candidate: null, reason: 'the reaction comes after the last word' }

  const lastSeg = segments[segments.length - 1]!
  const finalSec = concatDuration(segments) + (endSec - lastSeg.srcEnd)
  if (finalSec > c.maxFinalSec + 1e-6) return { candidate: null, reason: `${finalSec.toFixed(1)}s is over ${c.maxFinalSec}s` }
  if (finalSec < EDIT_RULES.length.finalFloorSec - 1e-6) return { candidate: null, reason: `${finalSec.toFixed(1)}s is under the ${EDIT_RULES.length.finalFloorSec}s floor` }
  return { candidate: { endSec, quietSec: used, quietMeasured: measured, speechEndSec: Math.min(trueEnd, endSec), finalSec }, reason: null }
}

// --- the seam itself --------------------------------------------------------

/** Size of the grey thumbnails the frames are compared at: the whole frame, and the facecam (square) when there is one. */
export const SEAM_FRAME = { width: 64, height: 36 } as const
export const SEAM_CAM_FRAME = { width: 64, height: 64 } as const

/**
 * FFmpeg arguments (an argument array, never a shell) that write one frame at
 * `atSec` of `input` to stdout as raw grey pixels, downscaled with area
 * averaging; with `cam` (a 0..1 rectangle of the frame) only that area.
 */
export function buildFrameGrabArgs(input: string, atSec: number, cam: Rect | null): string[] {
  const size = cam ? SEAM_CAM_FRAME : SEAM_FRAME
  const crop = cam ? `crop=iw*${cam.w.toFixed(4)}:ih*${cam.h.toFixed(4)}:iw*${cam.x.toFixed(4)}:ih*${cam.y.toFixed(4)},` : ''
  return ['-hide_banner', '-nostdin', '-v', 'error', '-ss', Math.max(0, atSec).toFixed(3), '-i', input, '-frames:v', '1', '-vf', `${crop}scale=${size.width}:${size.height}:flags=area,format=gray`, '-f', 'rawvideo', '-']
}

export interface SeamMeasure {
  /** 0..1, how alike the first and last picture are (correlation; see `frameSimilarity`). */
  frameSimilarity: number
  /** Absolute dB difference between the speech level at the start and at the end. */
  loudnessDiffLu: number
}

const mean = (a: ArrayLike<number>, n: number): number => {
  let s = 0
  for (let i = 0; i < n; i++) s += a[i]!
  return s / n
}

/**
 * 0..1 from two equally sized grey pictures: their correlation (so a change of
 * brightness alone does not count, only a change of what is where), 0 for
 * anti-correlated ones. Two flat pictures have nothing to correlate and are
 * compared by tone instead: 1 for the same grey, 0 at a difference of
 * `frameDiffFullScale` levels or more.
 */
export function frameSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  const ma = mean(a, n)
  const mb = mean(b, n)
  let sab = 0
  let saa = 0
  let sbb = 0
  for (let i = 0; i < n; i++) {
    const x = a[i]! - ma
    const y = b[i]! - mb
    sab += x * y
    saa += x * x
    sbb += y * y
  }
  const flat = 1e-6 * n
  if (saa < flat || sbb < flat) {
    if (saa < flat && sbb < flat) return Math.max(0, Math.min(1, 1 - Math.abs(ma - mb) / EDIT_RULES.loop.frameDiffFullScale))
    return 0
  }
  return Math.max(0, Math.min(1, sab / Math.sqrt(saa * sbb)))
}

/** Median dB of the frames the given words cover; null with no words or no coverage. */
export function speechLevelDb(env: Envelope, words: readonly Word[]): number | null {
  const levels: number[] = []
  for (const w of words) for (let t = w.t0; t < w.t1 - 1e-9; t += env.stepSec) {
    const db = dbAt(env, t)
    if (db !== null && db > -60) levels.push(db)
  }
  return median(levels)
}

/**
 * |speech level at the start - speech level at the end| across the seam: the
 * median dB of the words in the first `speechWindowSec` from `startSec` (where
 * the first word starts) against the words in the last `speechWindowSec` up
 * to `endSec` (where the last word ends, before the quiet the loop ends on).
 * Words, not a fixed 0.4 s of audio: a window that catches a gap or the quiet
 * tail reads as a big step from speech to silence. Null when either side has
 * no measurable words. Times clip-relative, `env` clip-relative too.
 */
export function speechLevelDiff(env: Envelope, words: readonly Word[], startSec: number, endSec: number): number | null {
  const win = EDIT_RULES.loop.speechWindowSec
  const a = speechLevelDb(env, words.filter((w) => w.t0 >= startSec - 1e-6 && w.t1 <= startSec + win))
  const b = speechLevelDb(env, words.filter((w) => w.t1 <= endSec + 1e-6 && w.t0 >= endSec - win))
  return a === null || b === null ? null : Math.abs(a - b)
}

export function seamPasses(m: SeamMeasure): boolean {
  return m.frameSimilarity >= EDIT_RULES.loop.minFrameSimilarity && m.loudnessDiffLu <= EDIT_RULES.loop.maxLoudnessDiffLu
}

/** The audio crossfade for a loop of this length, inside 30-100 ms and never more than a tenth of the clip. */
export function seamCrossfadeSec(finalSec: number): number {
  const c = EDIT_RULES.loop
  return Math.max(c.crossfadeMinSec, Math.min(c.crossfadeMaxSec, c.crossfadeSec, finalSec / 10))
}

export function checkLoop(candidate: LoopCandidate | null, reason: string | null, seam: SeamMeasure | null, wantedByStructure: boolean): CheckResult {
  if (!candidate) return { check: 'loop', status: 'na', values: { eligible: false, why: reason ?? 'none', wanted: wantedByStructure } }
  const passes = seam ? seamPasses(seam) : null
  return {
    check: 'loop',
    status: passes === null ? 'na' : passes ? 'pass' : 'fail',
    values: {
      eligible: passes === true,
      final: candidate.finalSec,
      quiet: candidate.quietSec,
      quietMeasured: candidate.quietMeasured,
      frameSim: seam?.frameSimilarity ?? null,
      loudDiff: seam?.loudnessDiffLu ?? null,
      uncalibrated: false,
      wanted: wantedByStructure
    }
  }
}
