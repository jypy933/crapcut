// Pure helpers for re-transcribing a chosen clip's own audio with the larger,
// slower speech model once moments has picked its window. Stretches of the VOD
// that ran on the fast model on the CPU (see `shared/hardware.ts`'s
// `needsClipCaptionPass`) are worth the extra time, and only for the padded
// range of a kept clip. See `pipeline/steps.ts`'s `clipCaptions` step, which
// does the actual cutting and transcribing.

import type { Clip, Range, Word } from '@shared/types'

/**
 * A transcribed chunk as far as this pass cares. `sharp` is written by the
 * transcribe step when the chunk ran the large model on the GPU (or had no
 * speech to transcribe); a chunk that fell back to the CPU, or one written
 * before this was recorded, has it missing or false.
 */
export interface ChunkRecord {
  range: Range
  sharp?: boolean
}

/** The stretches of the VOD that were not transcribed with the large model on the GPU. */
export function fastChunkRanges(chunks: readonly ChunkRecord[]): Range[] {
  return chunks.filter((c) => c.sharp !== true).map((c) => c.range)
}

/** Whether a clip's range touches any of the given stretches. */
export function overlapsAnyRange(range: Range, ranges: readonly Range[]): boolean {
  return ranges.some((r) => r.start < range.end && r.end > range.start)
}

/**
 * The VOD-time range to re-transcribe for a clip: its cut plus the same
 * padding its words were first windowed with (see `steps.ts`'s
 * `CLIP_PAD_SEC` and `wordsIn`), clamped to the VOD.
 */
export function clipCaptionRange(clip: Pick<Clip, 'start' | 'end'>, durationSec: number, padSec: number): Range {
  return { start: Math.max(0, clip.start - padSec), end: Math.min(durationSec, clip.end + padSec) }
}

/**
 * True when a clip's captions must be left alone: he has already hand-edited
 * them in Review. Only relevant for a job resumed from before this step ran
 * (a fresh job never reaches Review until every clip has been through it).
 */
export function shouldSkipClipCaptions(clip: Pick<Clip, 'wordsEdited'>): boolean {
  return clip.wordsEdited === true
}

/**
 * The words to keep for a clip after one re-transcription attempt: the fresh
 * pass if it actually found anything, otherwise the fast-pass words it
 * already had (a failed tool run, or a clip that landed on a muted stretch).
 */
export function resolveClipCaptionWords(fastPassWords: Word[], reTranscribed: Word[] | null): Word[] {
  return reTranscribed && reTranscribed.length > 0 ? reTranscribed : fastPassWords
}
