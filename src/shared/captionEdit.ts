// Editing caption text while keeping word timings sensible.

import type { CaptionGroup } from './captions'
import type { Word } from './types'

/**
 * Replaces the words of one caption group with new text.
 *
 * `group` is normally the clip-relative group shown in Review, built from
 * `groupWords(clipWords(...))`; `clipStart` (0 if `all` and `group` already
 * share a time base) shifts its first word's start into `all`'s time base.
 * That shift is used only as an approximate anchor for picking the right
 * occurrence when the same short phrase appears more than once in the clip -
 * matching itself is by word text, never by exact timestamps. A boundary
 * word's displayed timing can be clamped to the clip's edges (see
 * `clipWords`), so it would otherwise never line up bit-for-bit with the
 * original word it came from, which used to leave the old words behind as
 * duplicates instead of replacing them.
 *
 * Same number of words: original timings are kept. Different number: the
 * matched span is shared evenly. Empty text removes the group's words. If no
 * matching run of words is found (should not normally happen), `all` is
 * returned unchanged rather than risk duplicating anything.
 */
export function editGroupText(all: Word[], group: CaptionGroup, text: string, clipStart = 0): Word[] {
  const n = group.words.length
  if (n === 0) return all
  const wantTexts = group.words.map((w) => w.text.trim())
  const anchor = group.words[0]!.t0 + clipStart

  let bestIndex = -1
  let bestDelta = Infinity
  for (let i = 0; i + n <= all.length; i++) {
    let matches = true
    for (let j = 0; j < n; j++) {
      if (all[i + j]!.text.trim() !== wantTexts[j]) {
        matches = false
        break
      }
    }
    if (!matches) continue
    const delta = Math.abs(all[i]!.t0 - anchor)
    if (delta < bestDelta) {
      bestDelta = delta
      bestIndex = i
    }
  }
  if (bestIndex === -1) return all

  const from = all[bestIndex]!.t0
  const to = all[bestIndex + n - 1]!.t1
  const before = all.slice(0, bestIndex)
  const after = all.slice(bestIndex + n)
  const tokens = text.split(/\s+/).map((t) => t.trim()).filter(Boolean)

  let replaced: Word[]
  if (tokens.length === n) {
    replaced = tokens.map((t, i) => ({ t0: all[bestIndex + i]!.t0, t1: all[bestIndex + i]!.t1, text: t }))
  } else {
    const span = Math.max(0.05, to - from)
    const step = span / Math.max(1, tokens.length)
    replaced = tokens.map((t, i) => ({ t0: round3(from + i * step), t1: round3(from + (i + 1) * step), text: t }))
  }
  return [...before, ...replaced, ...after]
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** Shifts clip-relative words back to VOD time. */
export function toVodTime(words: Word[], clipStart: number): Word[] {
  return words.map((w) => ({ t0: round3(w.t0 + clipStart), t1: round3(w.t1 + clipStart), text: w.text }))
}
