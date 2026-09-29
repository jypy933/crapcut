// Fixes whisper.cpp word timings that stretch a single word across a
// silence (a pause, a muted patch, a slow ramp-in on the audio). A stretched
// word makes its caption appear long before it is said, or linger long after,
// and it hides the pause that clip cutting and captions rely on.
//
// The best fix uses the audio (see `main/core/transcript.ts`
// `repairChunkWordTimings`, which finds the real speech inside a stretched
// word's span using a fine loudness envelope). This module is the fallback
// for when there is no audio to hand: a plain text heuristic, used for the
// renderer preview, the ASS export and any transcript from before this fix.
// It is idempotent: running it again on already-repaired words changes
// nothing, so it is safe to apply every time captions are built.

import type { Word } from './types'

export interface WordTimingOptions {
  /** Seconds of plausible speech per character. */
  secPerChar: number
  /** No word is trusted to last less than this, however short its text. */
  minDuration: number
  /** No word is trusted to last more than this, however long its text. */
  maxDuration: number
  /** A silence at least this long before a word suggests a new sentence. */
  sentenceGapSec: number
}

// Tuned on a real 6-hour transcript (16,898 words): a typical spoken word is
// 2-6 letters at ordinary pace, which lands well inside 0.25-1.5 s.
export const DEFAULT_WORD_TIMING: WordTimingOptions = {
  secPerChar: 0.12,
  minDuration: 0.22,
  maxDuration: 1.5,
  sentenceGapSec: 0.5
}

/** The longest a word's text plausibly takes to say. */
export function maxPlausibleDuration(text: string, opts: WordTimingOptions = DEFAULT_WORD_TIMING): number {
  const letters = text.replace(/[^\p{L}\p{N}]/gu, '').length || 1
  return Math.min(opts.maxDuration, Math.max(opts.minDuration, letters * opts.secPerChar))
}

/** Whether a word's timing is implausible for its length. */
export function isStretchedWord(word: Word, opts: WordTimingOptions = DEFAULT_WORD_TIMING): boolean {
  return word.t1 - word.t0 > maxPlausibleDuration(word.text, opts)
}

function endsSentence(text: string): boolean {
  return /[.!?][)"'’”]*$/.test(text.trim())
}

function startsUppercase(text: string): boolean {
  const t = text.trim()
  return t.length > 0 && /\p{Lu}/u.test(t[0]!)
}

/**
 * Whether a stretched word was really spoken near its neighbours AFTER it
 * (keep its end, move its start later) rather than near the ones BEFORE it
 * (keep its start, pull its end in). True when it starts a new sentence: the
 * previous word ended one, or this word is capitalised after a real pause.
 */
export function belongsWithFollowing(word: Word, prev: Word | null, opts: WordTimingOptions = DEFAULT_WORD_TIMING): boolean {
  if (!prev) return false
  if (endsSentence(prev.text)) return true
  return startsUppercase(word.text) && word.t0 - prev.t1 >= opts.sentenceGapSec
}

/**
 * Repairs stretched words with a text-only heuristic: shrink an implausibly
 * long word to a plausible length, keeping the side its neighbours suggest
 * it truly belongs to. Words are assumed sorted and non-overlapping (as
 * `tidyWords` leaves them). Safe to run more than once.
 */
export function repairWordTimings(words: Word[], opts: WordTimingOptions = DEFAULT_WORD_TIMING): Word[] {
  const out: Word[] = []
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    if (!isStretchedWord(w, opts)) {
      out.push(w)
      continue
    }
    const prev = out[out.length - 1] ?? null
    const max = maxPlausibleDuration(w.text, opts)
    if (belongsWithFollowing(w, prev, opts)) {
      const t0 = Math.max(prev ? prev.t1 : 0, w.t1 - max)
      out.push({ ...w, t0: Math.min(t0, w.t1) })
    } else {
      out.push({ ...w, t1: w.t0 + max })
    }
  }
  return out
}
