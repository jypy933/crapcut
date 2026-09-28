// Editing caption text while keeping word timings sensible.

import type { CaptionGroup } from './captions'
import type { Word } from './types'

/**
 * Replaces the words of one caption group with new text. Same number of words:
 * timings are kept. Different number: the group's time span is shared evenly.
 * Empty text removes the group's words.
 */
export function editGroupText(all: Word[], group: CaptionGroup, text: string): Word[] {
  const first = group.words[0]
  const last = group.words[group.words.length - 1]
  if (!first || !last) return all
  const from = first.t0
  const to = last.t1
  const tokens = text.split(/\s+/).map((t) => t.trim()).filter(Boolean)
  const inGroup = (w: Word): boolean => w.t0 >= from - 1e-6 && w.t1 <= to + 1e-6 && group.words.some((g) => Math.abs(g.t0 - w.t0) < 1e-6 && g.text === w.text.trim())
  const outside = all.filter((w) => !inGroup(w))
  let replaced: Word[]
  if (tokens.length === group.words.length) {
    replaced = group.words.map((w, i) => ({ t0: w.t0, t1: w.t1, text: tokens[i]! }))
  } else {
    const span = Math.max(0.05, to - from)
    const step = span / Math.max(1, tokens.length)
    replaced = tokens.map((t, i) => ({ t0: round3(from + i * step), t1: round3(from + (i + 1) * step), text: t }))
  }
  return [...outside, ...replaced].sort((a, b) => a.t0 - b.t0)
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/** Shifts clip-relative words back to VOD time. */
export function toVodTime(words: Word[], clipStart: number): Word[] {
  return words.map((w) => ({ t0: round3(w.t0 + clipStart), t1: round3(w.t1 + clipStart), text: w.text }))
}
