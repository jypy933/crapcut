// Caption grouping shared by the preview (renderer) and the burn-in (main), so
// what the user sees in review is what gets exported.

import type { Word } from './types'

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
    if (current.length >= opts.maxWords || (current.length > 0 && chars + addChars > opts.maxChars) || gap > opts.maxGap) flush()
    current.push({ ...w, text })
    chars += (current.length > 1 ? 1 : 0) + text.length
    if (/[.!?…]$/.test(text)) flush()
  }
  flush()
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

/** Shifts words to clip-relative time and keeps those inside [0, duration). */
export function clipWords(words: Word[], clipStart: number, clipEnd: number): Word[] {
  const out: Word[] = []
  for (const w of words) {
    if (w.t1 <= clipStart || w.t0 >= clipEnd) continue
    out.push({ t0: Math.max(0, w.t0 - clipStart), t1: Math.min(clipEnd, w.t1) - clipStart, text: w.text })
  }
  return out
}

/** Caption text as the viewer will read it. */
export function displayText(text: string, uppercase: boolean): string {
  return uppercase ? text.toLocaleUpperCase() : text
}
