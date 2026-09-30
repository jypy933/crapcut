// Whether a clip can end as a seamless loop, and how good the seam is. A loop
// is a property of a version: it needs the final length to be 30 s or less, an
// end on the last word plus a short quiet, a first frame that looks like the
// last one, and a last 400 ms about as loud as the first. The video is a hard
// cut and the audio is faded over 30-100 ms (see `Ending` in `edl.ts`); there
// is no end card. Pure: the frames and loudness are measured elsewhere
// (`pipeline/seamMeasure.ts`, FFmpeg at edit time) and scored here.
// The frame threshold is a starting value nobody has calibrated on real clips.

import type { Rect, Word } from '@shared/types'
import { dbAt, EDIT_RULES, speechFloorDb, type CheckResult, type Envelope } from './editRules'
import { concatDuration, type EdlSegment } from './edl'

export interface LoopCandidate {
  /** Clip-relative second the looped edit ends at: the last word's real end plus its quiet. */
  endSec: number
  quietSec: number
  /** The quiet was read from a fine envelope; otherwise it is the target, not a measurement. */
  quietMeasured: boolean
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
  return { candidate: { endSec, quietSec: used, quietMeasured: measured, finalSec }, reason: null }
}

// --- the seam itself --------------------------------------------------------

/** Size of the grey thumbnails the frames are compared at: the whole frame, and the facecam (square) when there is one. */
export const SEAM_FRAME = { width: 32, height: 18 } as const
export const SEAM_CAM_FRAME = { width: 32, height: 32 } as const

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
  /** 0..1, how alike the first and last frame are. */
  frameSimilarity: number
  /** Absolute dB difference between the first and last 400 ms (an RMS stand-in for LU). */
  loudnessDiffLu: number
}

/** 0..1 from two equally sized grey frames: 1 for identical, 0 at a mean difference of `frameDiffFullScale` grey levels or more. */
export function frameSimilarity(a: ArrayLike<number>, b: ArrayLike<number>): number {
  const n = Math.min(a.length, b.length)
  if (n === 0) return 0
  let sum = 0
  for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!)
  return Math.max(0, Math.min(1, 1 - sum / n / EDIT_RULES.loop.frameDiffFullScale))
}

/** Mean level (power mean, dB) of the envelope over [from, from + windowSec), or null with no coverage. */
export function windowLevelDb(env: Envelope, from: number, windowSec = EDIT_RULES.loop.loudnessWindowSec): number | null {
  let power = 0
  let n = 0
  for (let t = from; t < from + windowSec - 1e-9; t += env.stepSec) {
    const db = dbAt(env, t)
    if (db === null) continue
    power += Math.pow(10, db / 10)
    n++
  }
  return n === 0 ? null : 10 * Math.log10(power / n)
}

/** |start level - end level| across the seam, or null when either end is not covered. Times clip-relative. */
export function seamLoudnessDiff(env: Envelope, startSec: number, endSec: number): number | null {
  const a = windowLevelDb(env, startSec)
  const b = windowLevelDb(env, endSec - EDIT_RULES.loop.loudnessWindowSec)
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
      uncalibrated: true,
      wanted: wantedByStructure
    }
  }
}
