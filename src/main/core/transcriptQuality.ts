// Flags stretches of a whisper.cpp transcript that are not reliable speech:
// looping hallucinations, known filler lines whisper produces over silence or
// music (credits, "thank you"), low-variety rambling and word timings that
// cannot be real speech. Used by the moments step so a candidate is never
// rated or titled from fake text, before a clip is even shown to him for
// review. Pure and unit-tested without Electron; see `pipeline/steps.ts`.

import type { Range, Word } from '@shared/types'
import { DEFAULT_LOOP_OPTIONS, findLoopRuns, normaliseWord, type LoopOptions } from '@shared/transcriptLoops'
import { mergeRanges, overlapSeconds } from './media'
import { wordsIn } from './transcript'

export interface BadSpan extends Range {
  /** Why this span was flagged, for logs only. */
  reason: string
}

export interface QualityOptions extends LoopOptions {
  /** Sliding window size (in words) for the lexical-diversity check. */
  diversityWindowWords: number
  /** A window with fewer distinct words than this fraction of its size reads as rambling/looping, not real variety. */
  minDiversity: number
  /** No real spoken word is shorter than this; several in a row this short is a timing artefact, not fast speech. */
  minWordDurationSec: number
  /** This many implausibly short words in a row counts as crammed/artefact timing. */
  crammedRun: number
  /** However long its text, a single word lasting longer than this cannot be real. */
  maxWordDurationSec: number
  /** A window at least this covered by bad spans has essentially no usable speech. */
  dropBadFraction: number
  /** Fewer real (non-bad) words than this in a window also counts as no speech. */
  minRealWords: number
  /** Chat this strong keeps a no-speech candidate anyway (the moment is real even if the transcript is not). */
  strongChatZ: number
  /** Loudness this strong keeps a no-speech candidate anyway. */
  strongAudioZ: number
}

export const DEFAULT_QUALITY_OPTIONS: QualityOptions = {
  ...DEFAULT_LOOP_OPTIONS,
  diversityWindowWords: 24,
  minDiversity: 0.35,
  minWordDurationSec: 0.03,
  crammedRun: 6,
  maxWordDurationSec: 8,
  dropBadFraction: 0.6,
  minRealWords: 4,
  strongChatZ: 4,
  strongAudioZ: 5
}

// Lines whisper.cpp is known to hallucinate over silence or background music,
// regardless of how many times they repeat -- a streamer never organically
// says a subtitle credit.
const KNOWN_FILLER_LINES = [
  /^thank you\.?$/i,
  /^thanks for watching[.!]?$/i,
  /^(please )?(like and )?subscribe[.!]?$/i,
  /^merci\.?$/i,
  /^merci d.avoir regard[ée]\.?$/i,
  /^sous-?titres? (r[ée]alis[ée]s?|faits?) par/i,
  /amara\.org/i
]

function loopSpans(words: Word[], opts: QualityOptions): BadSpan[] {
  return findLoopRuns(words, opts).map((r) => ({
    start: words[r.start]!.t0,
    end: words[r.end - 1]!.t1,
    reason: `looped text (x${r.repeats})`
  }))
}

/**
 * Groups words into sentences (split at . ! ?) and flags ones that are a
 * known hallucinated line. Every known filler line is short, so a sentence is
 * also cut off after a handful of words with no terminator -- otherwise a
 * stretch of real speech with no punctuation before a hallucination would
 * pull those words into the same check and the whole-line patterns would
 * never match.
 */
function fillerSpans(words: Word[]): BadSpan[] {
  const maxSentenceWords = 10
  const out: BadSpan[] = []
  let sentence: Word[] = []
  const flush = (): void => {
    if (sentence.length === 0) return
    const text = sentence
      .map((w) => w.text)
      .join(' ')
      .trim()
    if (KNOWN_FILLER_LINES.some((re) => re.test(text))) {
      out.push({ start: sentence[0]!.t0, end: sentence[sentence.length - 1]!.t1, reason: 'known filler line' })
    }
    sentence = []
  }
  for (const w of words) {
    sentence.push(w)
    if (/[.!?]$/.test(w.text.trim()) || sentence.length >= maxSentenceWords) flush()
  }
  flush()
  return out
}

/** A hallucinated filler line has no speech within this many seconds of it on either side. */
export const ISOLATED_FILLER_GAP_SEC = 4

/**
 * Removes known filler lines ("Thank you.") with nothing said for
 * `gapSec` before and after. Only for transcripts made without VAD: there
 * whisper fills every silent or noisy stretch with "Thank you." at the start
 * of its 30 s windows (measured: 2 per minute on silence, noise, music and
 * game sound alike, all gone with VAD on). With VAD on the line is real
 * speech far more often than not, so this is not applied there.
 */
export function dropIsolatedFiller(words: Word[], gapSec = ISOLATED_FILLER_GAP_SEC): Word[] {
  const drop = new Uint8Array(words.length)
  for (const span of fillerSpans(words)) {
    let first = words.findIndex((w) => w.t0 >= span.start)
    if (first < 0) continue
    let last = first
    while (last + 1 < words.length && words[last + 1]!.t1 <= span.end) last++
    const before = first > 0 ? span.start - words[first - 1]!.t1 : Infinity
    const after = last + 1 < words.length ? words[last + 1]!.t0 - span.end : Infinity
    if (before >= gapSec && after >= gapSec) for (; first <= last; first++) drop[first] = 1
  }
  return drop.some(Boolean) ? words.filter((_, i) => !drop[i]) : words
}

/** Sliding windows of low lexical variety: the same handful of words shuffled over and over, not a real sentence. */
function diversitySpans(words: Word[], opts: QualityOptions): BadSpan[] {
  const out: BadSpan[] = []
  const win = opts.diversityWindowWords
  if (words.length < win) return out
  for (let i = 0; i + win <= words.length; i++) {
    const slice = words.slice(i, i + win)
    const distinct = new Set(slice.map((w) => normaliseWord(w.text))).size
    if (distinct / win < opts.minDiversity) {
      out.push({ start: slice[0]!.t0, end: slice[slice.length - 1]!.t1, reason: 'low lexical diversity' })
    }
  }
  return out
}

/** Runs of near-zero-duration words, and single words stretched far past anything plausible. */
function timingSpans(words: Word[], opts: QualityOptions): BadSpan[] {
  const out: BadSpan[] = []
  let i = 0
  while (i < words.length) {
    if (words[i]!.t1 - words[i]!.t0 >= opts.minWordDurationSec) {
      i++
      continue
    }
    let j = i + 1
    while (j < words.length && words[j]!.t1 - words[j]!.t0 < opts.minWordDurationSec) j++
    if (j - i >= opts.crammedRun) out.push({ start: words[i]!.t0, end: words[j - 1]!.t1, reason: 'crammed word timings' })
    i = j
  }
  for (const w of words) {
    if (w.t1 - w.t0 > opts.maxWordDurationSec) out.push({ start: w.t0, end: w.t1, reason: 'implausibly long word' })
  }
  return out
}

function reasonFor(spans: BadSpan[], merged: Range): string {
  const reasons = new Set(spans.filter((s) => s.start < merged.end && s.end > merged.start).map((s) => s.reason))
  return [...reasons].join(', ')
}

/** All time ranges of the transcript that look like hallucination or a timing artefact rather than real speech, merged. */
export function findBadTranscriptRanges(words: Word[], opts: QualityOptions = DEFAULT_QUALITY_OPTIONS): BadSpan[] {
  const spans = [...loopSpans(words, opts), ...fillerSpans(words), ...diversitySpans(words, opts), ...timingSpans(words, opts)]
  if (spans.length === 0) return []
  return mergeRanges(spans, 0.5).map((r) => ({ ...r, reason: reasonFor(spans, r) }))
}

export interface SpeechAssessment {
  /** 0..1, how much of the window is covered by bad transcript ranges. */
  badFraction: number
  /** Words in the window that are not inside a bad range. */
  realWordCount: number
  /** Essentially no usable speech: badly covered, or almost no real words left. */
  noSpeech: boolean
}

/** How much of a candidate window's transcript looks real versus flagged. */
export function assessSpeech(window: Range, words: Word[], badRanges: Range[], opts: QualityOptions = DEFAULT_QUALITY_OPTIONS): SpeechAssessment {
  const len = Math.max(0.001, window.end - window.start)
  const badFraction = Math.min(1, overlapSeconds(window, badRanges) / len)
  const inside = wordsIn(words, window.start, window.end)
  const realWordCount = inside.filter((w) => !badRanges.some((b) => w.t0 < b.end && w.t1 > b.start)).length
  const noSpeech = badFraction >= opts.dropBadFraction || realWordCount < opts.minRealWords
  return { badFraction, realWordCount, noSpeech }
}

export type SpeechVerdict = 'ok' | 'keep_no_speech' | 'drop'

/**
 * Whether a candidate should reach the language model at all. A candidate
 * with real speech always goes through as before. One with essentially no
 * real speech is dropped, unless chat or loudness alone are strong enough
 * that something clearly happened on screen -- then it is kept, but marked so
 * the caller can pass it a cleaned transcript instead of the hallucinated
 * one (see `collapseLoops` in `@shared/transcriptLoops`).
 */
export function judgeSpeech(assessment: SpeechAssessment, chatZ: number, audioZ: number, opts: QualityOptions = DEFAULT_QUALITY_OPTIONS): SpeechVerdict {
  if (!assessment.noSpeech) return 'ok'
  return chatZ >= opts.strongChatZ || audioZ >= opts.strongAudioZ ? 'keep_no_speech' : 'drop'
}
