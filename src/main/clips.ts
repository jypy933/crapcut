// Applies a validated patch from the review screen to a clip, keeping every
// value possible: cuts stay inside the downloaded video, words stay sorted.

import type { ClipPatch } from '@shared/ipc'
import type { Clip, Word } from '@shared/types'

export const EDIT_MIN_SEC = 3
export const EDIT_MAX_SEC = 180

export function applyClipPatch(clip: Clip, patch: ClipPatch, layoutExists: (id: string) => boolean, vodDuration: number): Clip {
  const next: Clip = { ...clip }
  if (patch.title !== undefined) next.title = patch.title.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 100) || clip.title
  if (patch.status !== undefined) next.status = patch.status
  if (patch.captions !== undefined) next.captions = { ...patch.captions }
  if (patch.audio !== undefined) next.audio = patch.audio
  if (patch.formats !== undefined) next.formats = { ...patch.formats }
  if (patch.layoutId !== undefined) next.layoutId = patch.layoutId === null || layoutExists(patch.layoutId) ? patch.layoutId : clip.layoutId
  if (patch.words !== undefined) next.words = cleanWords(patch.words)

  if (patch.start !== undefined || patch.end !== undefined) {
    const bounds = clip.source ?? { start: 0, end: vodDuration }
    let start = patch.start ?? clip.start
    let end = patch.end ?? clip.end
    if (start > end) [start, end] = [end, start]
    start = Math.max(bounds.start, Math.min(start, bounds.end - EDIT_MIN_SEC))
    end = Math.min(bounds.end, Math.max(end, start + EDIT_MIN_SEC))
    if (end - start > EDIT_MAX_SEC) {
      if (patch.start !== undefined && patch.end === undefined) end = start + EDIT_MAX_SEC
      else start = end - EDIT_MAX_SEC
    }
    next.start = round3(start)
    next.end = round3(end)
  }
  return next
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** Trims text, drops empty words, fixes reversed times and sorts. */
export function cleanWords(words: Word[]): Word[] {
  return words
    .map((w) => ({ t0: Math.min(w.t0, w.t1), t1: Math.max(w.t0, w.t1), text: w.text.replace(/\s+/g, ' ').trim() }))
    .filter((w) => w.text.length > 0)
    .sort((a, b) => a.t0 - b.t0)
}

/** Back to what the finder suggested (keeps the downloaded source). */
export function resetClip(clip: Clip): Clip {
  return { ...clip, start: Math.max(clip.suggested.start, clip.source?.start ?? 0), end: Math.min(clip.suggested.end, clip.source?.end ?? Infinity) }
}
