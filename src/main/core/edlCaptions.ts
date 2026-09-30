// Segment-aware version of `shared/captions.ts`'s `clipWords`: remaps a
// clip's transcript words onto an EDL's output timeline instead of a single
// [clipStart, clipEnd) window. The result is plain `Word[]` in output
// seconds, so it feeds `core/ass.ts`'s `buildAss` unchanged -- the safe-zone
// placement and grouping it already does keeps working with no changes there.

import type { Word } from '@shared/types'
import { repairWordTimings } from '@shared/wordTiming'
import { concatToOutputTime, segmentStarts, type Edl } from './edl'

/** Words shorter than this after clipping to a segment are dropped as noise. */
const MIN_WORD_DURATION = 0.01

/**
 * Drops words outside every kept segment, and shifts the words that survive
 * from source time onto the final output timeline: clipped to the segment
 * that holds them, divided by that segment's speed, then pushed later by any
 * freeze holding before it. A segment used twice (a cold open, then the full
 * moment) makes its words appear twice, once per use, each at its own place
 * in the output -- in output order, since callers (and `buildAss`'s grouping)
 * expect that.
 */
export function remapWordsToEdl(words: Word[], edl: Edl): Word[] {
  const repaired = repairWordTimings(words)
  const starts = segmentStarts(edl.segments)
  const out: Word[] = []

  edl.segments.forEach((seg, i) => {
    const concatStart = starts[i]!
    // A hard cut back to earlier footage (a cold open's return to the start) begins a fresh caption group: a group must never join the preview's last words to the replay's first.
    let returns = i > 0 && seg.srcStart < edl.segments[i - 1]!.srcStart
    for (const w of repaired) {
      if (w.t1 <= seg.srcStart || w.t0 >= seg.srcEnd) continue
      const clippedStart = Math.max(w.t0, seg.srcStart)
      const clippedEnd = Math.min(w.t1, seg.srcEnd)
      if (clippedEnd - clippedStart < MIN_WORD_DURATION) continue
      const concatT0 = concatStart + (clippedStart - seg.srcStart) / seg.speed
      const concatT1 = concatStart + (clippedEnd - seg.srcStart) / seg.speed
      out.push({
        t0: concatToOutputTime(edl.freeze, concatT0),
        t1: concatToOutputTime(edl.freeze, concatT1),
        text: w.text,
        ...(returns ? { newGroup: true } : {})
      })
      returns = false
    }
  })

  out.sort((a, b) => a.t0 - b.t0)
  return out
}
