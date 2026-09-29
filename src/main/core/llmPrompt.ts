// Prompt building and answer checking for the local LLM that refines each
// candidate moment (cut points, title, rating). The model's answer is never
// trusted: every field is validated and clamped, with a heuristic fallback.

import { z } from 'zod'
import type { Range, Word } from '@shared/types'
import { formatClock } from '@shared/format'
import type { ChatMessage } from './chat'
import { CLIP_MAX_SEC, CLIP_MIN_SEC, type Candidate } from './moments'
import { wordsIn } from './transcript'

export interface Excerpt {
  /** VOD seconds the excerpt starts at; prompt times are relative to this. */
  offset: number
  range: Range
  lines: string[]
}

/** Transcript lines "[12.3] text", split at pauses, relative to the excerpt start. */
export function excerptLines(words: Word[], range: Range, maxWordsPerLine = 14, pause = 0.6): string[] {
  const inside = wordsIn(words, range.start, range.end)
  const lines: string[] = []
  let cur: Word[] = []
  const flush = (): void => {
    if (!cur.length) return
    lines.push(`[${(cur[0]!.t0 - range.start).toFixed(1)}] ${cur.map((w) => w.text).join(' ')}`)
    cur = []
  }
  for (const w of inside) {
    const prev = cur[cur.length - 1]
    if (prev && (w.t0 - prev.t1 > pause || cur.length >= maxWordsPerLine)) flush()
    cur.push(w)
  }
  flush()
  return lines
}

/** The most repeated chat messages in a range, e.g. `"KEKW" ×34`. */
export function topChat(messages: ChatMessage[], range: Range, limit = 6): string[] {
  const counts = new Map<string, number>()
  for (const m of messages) {
    if (m.t < range.start || m.t > range.end) continue
    const text = m.text.trim().replace(/\s+/g, ' ').slice(0, 60)
    if (!text) continue
    counts.set(text, (counts.get(text) ?? 0) + 1)
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([t, n]) => (n > 1 ? `"${t}" ×${n}` : `"${t}"`))
}

export function excerptRange(c: Candidate, durationSec: number): Range {
  return { start: Math.max(0, c.event - 45), end: Math.min(durationSec, Math.max(c.peak, c.event) + 25) }
}

export interface PromptContext {
  title: string
  channel: string
  chapter: string | null
}

/**
 * Two short worked examples, one kept and one skipped, shown before the real
 * excerpt. Checked against the model this app actually ships (Qwen3.5 9B, a
 * quick real request plus the ones in llmPrompt.test.ts) to make sure they
 * do not derail its answers before adding them here.
 */
const FEW_SHOT_KEEP = [
  'Example:',
  'Excerpt: 20 seconds starting at 00:05:00 of the stream. Times below are seconds from the start of the excerpt.',
  'Chat reacted strongly around 10 s (chat).',
  'Most repeated chat messages then: "LOL" ×12.',
  '',
  'Transcript of the streamer:',
  '[0.0] wait what',
  '[2.0] oh my god he actually did it',
  '[10.0] no way that is insane',
  '',
  'Answer: {"keep": true, "rating": 8, "start": 0, "end": 14, "title": "He Actually Did It"}'
].join('\n')

const FEW_SHOT_SKIP = [
  'Example:',
  'Excerpt: 25 seconds starting at 00:40:00 of the stream. Times below are seconds from the start of the excerpt.',
  'The streamer got loud around 12 s.',
  'No chat messages.',
  '',
  'Transcript of the streamer:',
  '[0.0] yeah so basically the loot table works like this',
  '[6.0] its kind of complicated honestly',
  '',
  'Answer: {"keep": false, "rating": 2, "start": 0, "end": 25, "title": ""}'
].join('\n')

export const SYSTEM_PROMPT =
  'You are an expert short-form video editor. You pick clips from livestream VODs for TikTok, YouTube Shorts and Instagram Reels. ' +
  'You answer with JSON only.'

const ANSWER_LINE = 'Answer as JSON: {"keep": boolean, "rating": integer, "start": number, "end": number, "title": string}'

export const REFINE_TASK = [
  'Task:',
  `1. Decide if the excerpt makes a good ${CLIP_MIN_SEC}-${CLIP_MAX_SEC} second vertical clip on its own (funny, surprising, skillful, emotional or quotable).`,
  '2. Choose start and end in excerpt seconds: start where a viewer understands what is happening (a hook in the first seconds), end right after the payoff or reaction. Do not cut a sentence in half.',
  '3. Write a short catchy title (at most 60 characters) in the same language as the transcript. No hashtags, no quotes.',
  '4. Rate it from 1 (boring) to 10 (must post).'
].join('\n')

export const SCAN_TASK = [
  'Task:',
  `1. Is there a moment in the excerpt that would make a great ${CLIP_MIN_SEC}-${CLIP_MAX_SEC} second vertical clip on its own (funny, surprising, skillful, emotional or quotable)? If not, set keep to false.`,
  '2. If yes, choose start and end in excerpt seconds: a hook in the first seconds, end right after the payoff. Do not cut a sentence in half.',
  '3. Write a short catchy title (at most 60 characters) in the same language as the transcript. No hashtags, no quotes.',
  '4. Rate it from 1 (boring) to 10 (must post). Be strict: most excerpts are a 3 or 4.'
].join('\n')

/** Same for every request of a job. */
function streamLine(ctx: PromptContext): string {
  return `Stream: "${sanitize(ctx.title)}" by ${sanitize(ctx.channel)}.`
}

/** The game or category an excerpt falls in; it changes within a job, so it goes with the excerpt. */
function playing(ctx: PromptContext): string {
  return ctx.chapter ? ` (playing: ${sanitize(ctx.chapter)})` : ''
}

/**
 * Everything that is the same for every candidate of a job (role, stream line,
 * task, the two examples) goes in the system message, and only the excerpt in
 * the user message. llama-server keeps a checkpoint of the model state at the
 * start of the last user message (the model is a hybrid one that cannot rewind
 * to an arbitrary token), so the next request only has to read the excerpt.
 */
export function refineSystemPrompt(ctx: PromptContext): string {
  return [SYSTEM_PROMPT, '', streamLine(ctx), '', REFINE_TASK, '', FEW_SHOT_KEEP, '', FEW_SHOT_SKIP].join('\n')
}

/** The excerpt part of a candidate's request; pairs with `refineSystemPrompt`. */
export function buildPrompt(ctx: PromptContext, c: Candidate, excerpt: Excerpt, chat: string[]): string {
  const len = excerpt.range.end - excerpt.range.start
  const reaction = c.chatZ > 0 ? `Chat reacted strongly around ${(c.peak - excerpt.offset).toFixed(0)} s` : `The streamer got loud around ${(c.peak - excerpt.offset).toFixed(0)} s`
  return [
    'Now the real excerpt.',
    `Excerpt: ${len.toFixed(0)} seconds starting at ${formatClock(excerpt.offset)} of the stream${playing(ctx)}. Times below are seconds from the start of the excerpt.`,
    `${reaction}${c.reasons.length ? ` (${c.reasons.join(', ')})` : ''}.`,
    chat.length ? `Most repeated chat messages then: ${chat.join(', ')}.` : 'No chat messages.',
    '',
    'Transcript of the streamer:',
    excerpt.lines.length ? excerpt.lines.join('\n') : '(no speech)',
    '',
    ANSWER_LINE
  ].join('\n')
}

/** System message for scanning a stretch of transcript when chat gave too few moments. */
export function scanSystemPrompt(ctx: PromptContext): string {
  return [SYSTEM_PROMPT, '', streamLine(ctx), '', SCAN_TASK].join('\n')
}

/** The excerpt part of a scan request; pairs with `scanSystemPrompt`. */
export function buildScanPrompt(ctx: PromptContext, excerpt: Excerpt): string {
  const len = excerpt.range.end - excerpt.range.start
  return [
    `Excerpt: ${len.toFixed(0)} seconds starting at ${formatClock(excerpt.offset)} of the stream${playing(ctx)}. Times below are seconds from the start of the excerpt.`,
    '',
    'Transcript of the streamer:',
    excerpt.lines.join('\n'),
    '',
    ANSWER_LINE
  ].join('\n')
}

/**
 * Transcript windows worth scanning: about `windowSec` long, with enough
 * speech, not muted and not overlapping moments already found.
 */
export function scanWindows(durationSec: number, words: Word[], avoid: Range[], windowSec = 180, minWords = 60): Range[] {
  const out: Range[] = []
  for (let start = 0; start < durationSec - 30; start += windowSec) {
    const r = { start, end: Math.min(durationSec, start + windowSec) }
    if (avoid.some((a) => a.start < r.end && r.start < a.end)) continue
    if (wordsIn(words, r.start, r.end).length < minWords) continue
    out.push(r)
  }
  return out
}

function sanitize(s: string): string {
  return s.replace(/[\r\n"]+/g, ' ').slice(0, 120)
}

/** JSON schema sent to llama-server so the model can only produce this shape. */
export const ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    keep: { type: 'boolean' },
    rating: { type: 'integer', minimum: 1, maximum: 10 },
    start: { type: 'number' },
    end: { type: 'number' },
    title: { type: 'string', maxLength: 90 }
  },
  required: ['keep', 'rating', 'start', 'end', 'title'],
  additionalProperties: false
} as const

const Answer = z.object({
  keep: z.boolean(),
  rating: z.number().finite(),
  start: z.number().finite(),
  end: z.number().finite(),
  title: z.string()
})

export interface Refined {
  keep: boolean
  rating: number
  window: Range
  title: string | null
}

/** Checks the model's answer; returns null if it is unusable. */
export function parseAnswer(raw: string, excerpt: Excerpt, durationSec: number): Refined | null {
  let json: unknown
  try {
    const start = raw.indexOf('{')
    const end = raw.lastIndexOf('}')
    json = JSON.parse(raw.slice(start, end + 1))
  } catch {
    return null
  }
  const parsed = Answer.safeParse(json)
  if (!parsed.success) return null
  const a = parsed.data
  const len = excerpt.range.end - excerpt.range.start
  let s = Math.max(0, Math.min(len, Math.min(a.start, a.end)))
  let e = Math.max(0, Math.min(len, Math.max(a.start, a.end)))
  if (e - s < CLIP_MIN_SEC) {
    const mid = (s + e) / 2
    s = Math.max(0, mid - CLIP_MIN_SEC / 2)
    e = Math.min(len, s + CLIP_MIN_SEC)
  }
  if (e - s > CLIP_MAX_SEC) e = s + CLIP_MAX_SEC
  const window = { start: round2(excerpt.offset + s), end: round2(Math.min(durationSec, excerpt.offset + e)) }
  return { keep: a.keep, rating: Math.round(Math.max(1, Math.min(10, a.rating))), window, title: cleanTitle(a.title) }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

/** Strips quotes, hashtags and line breaks; null if nothing useful is left. */
export function cleanTitle(t: string): string | null {
  let s = t
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/#\S+/g, '')
    .replace(/^["'“”«»\s]+|["'“”«»\s]+$/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
  if (s.length > 60) s = `${s.slice(0, 59).trimEnd()}…`
  return s.length >= 2 ? s : null
}

/**
 * Combines two independent samples of the same candidate (the bigger
 * language model tier is asked twice, see the moments step): kept only if
 * both agree, with the rating and window averaged so one unlucky sample
 * cannot swing the result alone. Either sample failing to parse counts as no
 * agreement reached, same as null from a single sample.
 */
export function combineSamples(a: Refined | null, b: Refined | null): Refined | null {
  if (!a || !b) return null
  return {
    keep: a.keep && b.keep,
    rating: Math.round((a.rating + b.rating) / 2),
    window: { start: round2((a.window.start + b.window.start) / 2), end: round2((a.window.end + b.window.end) / 2) },
    title: a.title ?? b.title
  }
}

/** Final ranking score from the signal strength and the model's rating. */
export function combinedScore(signalScore: number, rating: number | null): number {
  if (rating === null) return signalScore
  return 0.55 * signalScore + 0.45 * (rating / 10)
}

/** Rating (1..10) that neither boosts nor shrinks a candidate's raw strength. */
const RATING_NEUTRAL = 5.5
const RATING_SENSITIVITY = 0.15
const RATING_FACTOR_MIN = 0.4
const RATING_FACTOR_MAX = 1.8

/**
 * How much the model's rating scales a candidate's raw signal strength, for
 * ranking and quality-gating (see `selectByQuality`) rather than just the
 * displayed score: without this, a loud-only moment the model loves could
 * never clear the quality bar, and a candidate it hates would rank exactly
 * as if no model had looked at it. Neutral around a middling rating, so no
 * model (`rating === null`) leaves strength unchanged, and clamped so one
 * extreme rating cannot make a candidate unbeatable or erase it outright --
 * a very low rating is instead handled as an outright drop, see
 * `selectByQuality`.
 */
export function ratingFactor(rating: number | null): number {
  if (rating === null) return 1
  const raw = 1 + (rating - RATING_NEUTRAL) * RATING_SENSITIVITY
  return Math.max(RATING_FACTOR_MIN, Math.min(RATING_FACTOR_MAX, raw))
}
