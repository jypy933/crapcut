// Caption grouping shared by the preview (renderer) and the burn-in (main), so
// what the user sees in review is what gets exported.

import type { Word } from './types'
import { collapseLoops } from './transcriptLoops'
import { repairWordTimings } from './wordTiming'

export interface CaptionGroup {
  words: Word[]
  start: number
  end: number
}

export interface GroupOptions {
  maxWords: number
  maxChars: number
  /** A pause longer than this starts a new group. */
  maxGap: number
  /** How long the last group of a phrase lingers after its last word. */
  linger: number
}

export const DEFAULT_GROUPING: GroupOptions = { maxWords: 3, maxChars: 18, maxGap: 0.6, linger: 0.4 }

/**
 * The shortest time a word stays highlighted: a couple of frames even at
 * 30 fps. Words timed closer together than this (a fast burst, or whisper
 * giving several words one timestamp) are spread out instead of flickering
 * past or never lighting up.
 */
export const MIN_HIGHLIGHT_SEC = 0.08

/** Splits words into short on-screen groups (TikTok style, a few words at a time). */
export function groupWords(words: Word[], opts: GroupOptions = DEFAULT_GROUPING): CaptionGroup[] {
  const groups: CaptionGroup[] = []
  let current: Word[] = []
  let chars = 0
  const flush = (): void => {
    if (current.length === 0) return
    groups.push({ words: current, start: current[0]!.t0, end: current[current.length - 1]!.t1 })
    current = []
    chars = 0
  }
  for (const w of words) {
    const text = w.text.trim()
    if (!text) continue
    const prev = current[current.length - 1]
    const gap = prev ? w.t0 - prev.t1 : 0
    const addChars = (current.length ? 1 : 0) + text.length
    if (current.length >= opts.maxWords || (current.length > 0 && chars + addChars > opts.maxChars) || gap > opts.maxGap || w.newGroup) flush()
    current.push({ ...w, text })
    chars += (current.length > 1 ? 1 : 0) + text.length
    if (/[.!?…]$/.test(text)) flush()
  }
  flush()
  // Across group boundaries too, so a word pushed later never lands after
  // the next group has already taken the screen.
  let prevStart = -Infinity
  for (const g of groups) {
    for (let i = 0; i < g.words.length; i++) {
      const w = g.words[i]!
      const t0 = Math.max(w.t0, prevStart + MIN_HIGHLIGHT_SEC)
      if (t0 !== w.t0) g.words[i] = { ...w, t0, t1: Math.max(w.t1, t0) }
      prevStart = t0
    }
    g.start = g.words[0]!.t0
    g.end = Math.max(g.end, g.words[g.words.length - 1]!.t1)
  }
  // Each group stays up until the next starts (or lingers briefly after a phrase).
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i]!
    const next = groups[i + 1]
    const lingerEnd = g.end + opts.linger
    g.end = Math.max(g.start + 0.05, next ? Math.min(lingerEnd, next.start) : lingerEnd)
  }
  return groups
}

/** The group and highlighted word index on screen at time t, or null. */
export function captionAt(groups: CaptionGroup[], t: number): { group: CaptionGroup; active: number } | null {
  let lo = 0
  let hi = groups.length - 1
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    const g = groups[mid]!
    if (t < g.start) hi = mid - 1
    else if (t >= g.end) lo = mid + 1
    else {
      let active = 0
      for (let i = 0; i < g.words.length; i++) if (g.words[i]!.t0 <= t) active = i
      return { group: g, active }
    }
  }
  return null
}

/**
 * Shifts words to clip-relative time and keeps those inside [0, duration).
 * Repairs stretched timings first, then collapses whisper's looping
 * hallucinations ("of of of") down to one occurrence, both on the clip's full
 * (padded) word list so neighbouring words outside [clipStart, clipEnd) are
 * still there to judge sentence boundaries and natural repeats by. Safe to
 * call on words a job saved before either fix (or already fixed), since both
 * are idempotent.
 */
export function clipWords(words: Word[], clipStart: number, clipEnd: number): Word[] {
  const out: Word[] = []
  for (const w of collapseLoops(repairWordTimings(words))) {
    if (w.t1 <= clipStart || w.t0 >= clipEnd) continue
    out.push({ t0: Math.max(0, w.t0 - clipStart), t1: Math.min(clipEnd, w.t1) - clipStart, text: w.text })
  }
  return out
}

/** Caption text as the viewer will read it. */
export function displayText(text: string, uppercase: boolean): string {
  return uppercase ? text.toLocaleUpperCase() : text
}

/**
 * A simple, text-only signal for words worth calling out: shouted (ALL CAPS),
 * a number, or ending in "!". Used by styles with keyword emphasis on.
 */
export function isKeywordWord(text: string): boolean {
  const t = text.trim()
  if (!t) return false
  const letters = t.replace(/[^A-Za-z]/g, '')
  const shouted = letters.length >= 2 && letters === letters.toUpperCase()
  const numeric = /\d/.test(t)
  const excited = t.length > 1 && t.endsWith('!')
  return shouted || numeric || excited
}
