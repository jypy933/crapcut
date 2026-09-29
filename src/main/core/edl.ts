// Types and pure helpers for an edit-decision-list (EDL): the recipe a
// (separately built) picker writes for turning one accepted clip into a
// viral short-form re-edit -- reordered/trimmed segments, a punch-in zoom and
// shake, freeze frames, per-segment speed, overlays and sound effects, and an
// ending. `edlFilter.ts` turns this into an FFmpeg filter graph and
// `edlCaptions.ts` remaps the clip's existing transcript words onto it. No
// I/O; times are plain numbers so this stays trivially unit-testable.

/** One piece of the source clip, in output order. `speed` of 1 is normal. */
export interface EdlSegment {
  /** Seconds into the source clip. */
  srcStart: number
  srcEnd: number
  speed: number
}

export interface ZoomKeyframe {
  /** Seconds on the final output timeline (after freezes are inserted). */
  t: number
  scale: number
  /** How the punch-in reaches this keyframe from the previous one: a hard cut or a ramp. */
  ease: 'snap' | 'smooth'
  /** Shake amplitude in output pixels, held from this keyframe until the next. */
  shakeAmp?: number
}

/**
 * A held frame inserted into the edit. `atOutputT` is a position on the
 * *concatenated* timeline (the segments joined, before any freeze is
 * inserted) -- every freeze is measured against that same, unmodified
 * timeline, so they never need adjusting for each other's hold time.
 */
export interface FreezeCue {
  atOutputT: number
  holdSec: number
}

export interface OverlayPos {
  /** 0..1 of the output frame. */
  x: number
  y: number
  align: 'left' | 'center' | 'right'
}

export interface OverlayCue {
  kind: 'quoteBar' | 'chatBubble'
  /** Seconds on the final output timeline. */
  t0: number
  t1: number
  /** Verbatim source text (a transcript line or chat message) -- never generated. */
  text: string
  pos: OverlayPos
}

export interface SfxCue {
  /** Seconds on the final output timeline. */
  t: number
  file: string
  gainDb: number
}

export type Ending =
  | { kind: 'cut' }
  | {
      kind: 'loop'
      /** Seconds replayed from the start of the output, appended at the end for a seamless loop. */
      introSec: number
      /** How much of that replay crossfades with the true ending, instead of ballooning the duration. */
      crossfadeSec: number
    }

export interface Edl {
  /** Output order; a segment may repeat (a cold open, then the moment again in full). */
  segments: EdlSegment[]
  zoom: ZoomKeyframe[]
  freeze: FreezeCue[]
  overlays: OverlayCue[]
  sfx: SfxCue[]
  ending: Ending
}

const EPS = 1e-6

export function segmentDuration(seg: EdlSegment): number {
  return Math.max(0, (seg.srcEnd - seg.srcStart) / seg.speed)
}

/** Concat-timeline start of each segment (before freezes or a loop ending are added). */
export function segmentStarts(segments: readonly EdlSegment[]): number[] {
  const starts: number[] = []
  let t = 0
  for (const s of segments) {
    starts.push(t)
    t += segmentDuration(s)
  }
  return starts
}

/** Length of the joined segments, before freezes or a loop ending. */
export function concatDuration(segments: readonly EdlSegment[]): number {
  return segments.reduce((sum, s) => sum + segmentDuration(s), 0)
}

/** Total hold time every freeze adds. */
export function freezeTotal(freeze: readonly FreezeCue[]): number {
  return freeze.reduce((sum, f) => sum + Math.max(0, f.holdSec), 0)
}

/** The extra length a loop ending adds: the replayed intro, minus the crossfade it shares with the true ending. */
function loopExtra(ending: Ending): number {
  return ending.kind === 'loop' ? Math.max(0, ending.introSec - ending.crossfadeSec) : 0
}

/** Total length of the final export. */
export function outputDuration(edl: Edl): number {
  return concatDuration(edl.segments) + freezeTotal(edl.freeze) + loopExtra(edl.ending)
}

/**
 * Shifts a concat-timeline timestamp onto the final output timeline, by
 * adding the hold time of every freeze at or before it. A freeze is a short
 * pause, not something a caption word is expected to straddle, so callers
 * shift a word's start and end the same way (see `edlCaptions.ts`).
 */
export function concatToOutputTime(freeze: readonly FreezeCue[], concatT: number): number {
  let shift = 0
  for (const f of freeze) if (f.atOutputT <= concatT + EPS) shift += Math.max(0, f.holdSec)
  return concatT + shift
}

/**
 * Every place a point in source time lands in the output, as concat-timeline
 * seconds -- one entry per segment that contains it. A segment reused for a
 * cold open and then the full moment yields two entries, in segment order.
 */
export function mapSourceTimeToConcat(segments: readonly EdlSegment[], srcT: number): number[] {
  const starts = segmentStarts(segments)
  const out: number[] = []
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!
    if (srcT >= s.srcStart - EPS && srcT <= s.srcEnd + EPS) {
      const clamped = Math.min(Math.max(srcT, s.srcStart), s.srcEnd)
      out.push(starts[i]! + (clamped - s.srcStart) / s.speed)
    }
  }
  return out
}

export interface EdlValidationError {
  message: string
}

/**
 * Checks the EDL is playable: segments are non-empty, inside the source, and
 * at a positive speed; freezes and overlays have a positive length and don't
 * duplicate a cue at the same spot; every output-timed cue (zoom, freeze,
 * overlay, sfx) falls inside the export. Segments are deliberately allowed to
 * share or overlap source ranges -- reusing a moment (a cold open, then the
 * full play) is intentional, not an error.
 */
export function validateEdl(edl: Edl, sourceDurationSec: number): EdlValidationError[] {
  const errors: EdlValidationError[] = []
  if (edl.segments.length === 0) errors.push({ message: 'an edit needs at least one segment' })
  edl.segments.forEach((s, i) => {
    if (s.srcEnd <= s.srcStart) errors.push({ message: `segment ${i} is empty or reversed` })
    if (s.srcStart < -EPS || s.srcEnd > sourceDurationSec + EPS) errors.push({ message: `segment ${i} is outside the source` })
    if (!(s.speed > 0)) errors.push({ message: `segment ${i} has a non-positive speed` })
  })

  const outDur = outputDuration(edl)

  const seenFreezeAt = new Set<string>()
  for (const f of edl.freeze) {
    if (!(f.holdSec > 0)) errors.push({ message: 'a freeze needs a positive hold' })
    const key = f.atOutputT.toFixed(3)
    if (seenFreezeAt.has(key)) errors.push({ message: 'two freezes at the same spot' })
    seenFreezeAt.add(key)
    if (f.atOutputT < -EPS || f.atOutputT > concatDuration(edl.segments) + EPS) errors.push({ message: 'a freeze falls outside the edit' })
  }

  for (const o of edl.overlays) {
    if (o.t1 <= o.t0) errors.push({ message: 'an overlay has an empty or reversed range' })
    if (o.t0 < -EPS || o.t1 > outDur + EPS) errors.push({ message: 'an overlay falls outside the output' })
    if (!o.text.trim()) errors.push({ message: 'an overlay has no text' })
  }

  for (const z of edl.zoom) if (z.t < -EPS || z.t > outDur + EPS) errors.push({ message: 'a zoom keyframe falls outside the output' })
  for (const s of edl.sfx) if (s.t < -EPS || s.t > outDur + EPS) errors.push({ message: 'an sfx cue falls outside the output' })

  if (edl.ending.kind === 'loop') {
    if (!(edl.ending.introSec > 0)) errors.push({ message: 'a loop ending needs a positive intro length' })
    if (!(edl.ending.crossfadeSec > 0) || edl.ending.crossfadeSec > edl.ending.introSec) errors.push({ message: 'a loop ending crossfade must fit inside its intro' })
  }

  return errors
}
