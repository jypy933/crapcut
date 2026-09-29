// Optional LLM tie-break for the structure pick: only used when the
// heuristic in `structurePick.ts` finds two or three structures (or two or
// more quotable spans) scored too close to call. The model never writes any
// on-screen text -- it only points at indices into the words and chat
// already given to it, and every index is range-checked before use. A
// malformed or out-of-range answer is dropped and the heuristic pick stands.
//
// This module is not wired into the pipeline: `pickStructureWithLlm` just
// takes a `complete` callback so it can be driven by a fake in tests, the
// same shape `pipeline/ai.ts`'s `LlamaServer.complete` will supply later.

import { z } from 'zod'
import type { ChatMessage, Word } from '@shared/types'
import { pickStructure, scoreStructures, TIE_MARGIN, type LlmChoice, type StructureDecision, type StructureId, type StructureScore } from './structurePick'
import type { StructureSignals } from './structureSignals'

/** System message for the structure tie-break request; pairs with `buildStructurePrompt`'s own instructions. */
export const STRUCTURE_SYSTEM_PROMPT = 'You pick between short-form video edit structures for one clip. Answer with the requested JSON object only, nothing else.'

/** "[<word index>] word word word", split at pauses -- indices, never seconds, so the model cannot invent a time. */
export function wordIndexLines(words: Word[], maxWordsPerLine = 14, pause = 0.6): string[] {
  const lines: string[] = []
  let cur: { i: number; w: Word }[] = []
  const flush = (): void => {
    if (!cur.length) return
    lines.push(`[${cur[0]!.i}] ${cur.map((c) => c.w.text).join(' ')}`)
    cur = []
  }
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const prev = cur[cur.length - 1]
    if (prev && (w.t0 - prev.w.t1 > pause || cur.length >= maxWordsPerLine)) flush()
    cur.push({ i, w })
  }
  flush()
  return lines
}

/** "<index>: "text"" for up to `limit` chat messages, indices matching their position in `chat`. */
export function chatIndexLines(chat: ChatMessage[], limit = 10): string[] {
  const out: string[] = []
  for (let i = 0; i < chat.length && out.length < limit; i++) {
    const text = chat[i]!.text.trim().replace(/\s+/g, ' ').slice(0, 60)
    if (text) out.push(`${i}: "${text}"`)
  }
  return out
}

const FEW_SHOT_1 = [
  'Example:',
  'Options:',
  '0: quoteCard',
  '1: buildAndPunch',
  'Transcript words, indexed:',
  '[0] no',
  '[1] way',
  '[2] he',
  '[3] actually',
  '[4] hit',
  '[5] that',
  'No chat messages.',
  'Answer: {"optionIndex": 0, "quoteStart": 0, "quoteEnd": 5, "emphasisWords": [0, 1], "chatMessages": []}'
].join('\n')

const FEW_SHOT_2 = [
  'Example:',
  'Options:',
  '0: chatFirst',
  '1: tightCut',
  'Transcript words, indexed:',
  '[0] wait',
  '[1] what',
  '[2] just',
  '[3] happened',
  'Chat messages, indexed:',
  '0: "KEKW"',
  '1: "no way"',
  '2: "LOL"',
  'Answer: {"optionIndex": 0, "quoteStart": 0, "quoteEnd": 0, "emphasisWords": [1], "chatMessages": [0, 1, 2]}'
].join('\n')

/** Builds the tie-break prompt from close-scoring options and the clip's own words/chat. */
export function buildStructurePrompt(options: StructureScore[], words: Word[], chat: ChatMessage[]): string {
  const wordLines = wordIndexLines(words)
  const chatLines = chatIndexLines(chat)
  return [
    'You are picking between short-form video edit structures for one clip; they scored too close to call automatically.',
    'Options:',
    ...options.map((o, i) => `${i}: ${o.structure}${o.reasons.length ? ` (${o.reasons.join(', ')})` : ''}`),
    '',
    'Transcript words, indexed (refer to these indices only, never seconds):',
    wordLines.length ? wordLines.join('\n') : '(no speech)',
    '',
    chatLines.length ? 'Chat messages, indexed:' : 'No chat messages.',
    ...chatLines,
    '',
    FEW_SHOT_1,
    '',
    FEW_SHOT_2,
    '',
    'Task:',
    '1. Pick the best-fitting option by its index.',
    '2. If a short verbatim quote fits, give a 3-8 word index range from the transcript above; otherwise repeat the same index for start and end.',
    '3. List up to 4 word indices worth emphasising in captions (shouted, a number, or excited).',
    '4. List up to 4 chat message indices that best show the reaction, if chat mattered here.',
    'Answer as JSON: {"optionIndex": integer, "quoteStart": integer, "quoteEnd": integer, "emphasisWords": integer[], "chatMessages": integer[]}'
  ].join('\n')
}

/** JSON schema sent to llama-server: indices only, nothing generated. */
export const STRUCTURE_ANSWER_SCHEMA = {
  type: 'object',
  properties: {
    optionIndex: { type: 'integer', minimum: 0 },
    quoteStart: { type: 'integer', minimum: 0 },
    quoteEnd: { type: 'integer', minimum: 0 },
    emphasisWords: { type: 'array', items: { type: 'integer', minimum: 0 }, maxItems: 6 },
    chatMessages: { type: 'array', items: { type: 'integer', minimum: 0 }, maxItems: 6 }
  },
  required: ['optionIndex', 'quoteStart', 'quoteEnd', 'emphasisWords', 'chatMessages'],
  additionalProperties: false
} as const

const Answer = z.object({
  optionIndex: z.number().finite(),
  quoteStart: z.number().finite(),
  quoteEnd: z.number().finite(),
  emphasisWords: z.array(z.number().finite()),
  chatMessages: z.array(z.number().finite())
})

/**
 * Checks the model's answer against the real options/words/chat it was
 * shown. The option pick is the answer's whole point, so a bad index there
 * rejects the answer outright; a bad quote range, emphasis index or chat
 * index is just dropped, since one unusable extra should not throw away an
 * otherwise good structure pick.
 */
export function parseStructureAnswer(raw: string, options: StructureId[], words: Word[], chat: ChatMessage[]): LlmChoice | null {
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
  const optionIndex = Math.round(a.optionIndex)
  if (!Number.isInteger(optionIndex) || optionIndex < 0 || optionIndex >= options.length) return null

  const choice: LlmChoice = { structure: options[optionIndex]! }

  const qs = Math.round(a.quoteStart)
  const qe = Math.round(a.quoteEnd)
  if (Number.isInteger(qs) && Number.isInteger(qe) && qs >= 0 && qe >= qs && qe < words.length && qe - qs + 1 <= 8 && qe !== qs) {
    choice.quoteSpan = { start: qs, end: qe }
  }

  const emphasis = [...new Set(a.emphasisWords.map((n) => Math.round(n)).filter((n) => Number.isInteger(n) && n >= 0 && n < words.length))].sort((x, y) => x - y)
  if (emphasis.length > 0) choice.emphasisWords = emphasis.slice(0, 6)

  const chatIds = [...new Set(a.chatMessages.map((n) => Math.round(n)).filter((n) => Number.isInteger(n) && n >= 0 && n < chat.length))].sort((x, y) => x - y)
  if (chatIds.length > 0) choice.chatMessageIds = chatIds.slice(0, 6)

  return choice
}

export interface StructureLlmInputs {
  signals: StructureSignals
  /** The same word array `computeSignals` was given, so returned indices line up. */
  words: Word[]
  chatMessages: ChatMessage[]
  /** VOD second the clip starts at, for `payoffFirst`'s cold-open span. Defaults to 0 (already clip-relative). */
  clipStartSec?: number
}

export type CompleteFn = (prompt: string, schema: object) => Promise<string>

/** The heuristic's top structures, within `TIE_MARGIN` of the best score, closest first; at most 3. */
function closeScores(scored: StructureScore[]): StructureScore[] {
  const ranked = [...scored].sort((a, b) => b.score - a.score)
  const top = ranked[0]!.score
  return ranked.filter((s) => top - s.score <= TIE_MARGIN).slice(0, 3)
}

/**
 * Runs the heuristic pick, and only calls out to the model when it left
 * things ambiguous: the top structures were within `TIE_MARGIN` of each
 * other, or there were multiple candidate quotable spans to choose between.
 * Any failure to reach the model, or an answer that does not check out,
 * falls back to the plain heuristic pick -- this function never throws for
 * that reason.
 */
export async function pickStructureWithLlm(inputs: StructureLlmInputs, complete: CompleteFn): Promise<StructureDecision> {
  const { signals, words, chatMessages, clipStartSec = 0 } = inputs
  const scored = scoreStructures(signals)
  const close = closeScores(scored)
  const spansTie = signals.quotableSpans.length >= 2
  if (close.length < 2 && !spansTie) return pickStructure(signals, words, clipStartSec)

  const options = close.length >= 2 ? close : scored.filter((s) => s.structure === 'quoteCard')
  const prompt = buildStructurePrompt(options, words, chatMessages)
  let raw: string
  try {
    raw = await complete(prompt, STRUCTURE_ANSWER_SCHEMA)
  } catch {
    return pickStructure(signals, words, clipStartSec)
  }
  const choice = parseStructureAnswer(
    raw,
    options.map((o) => o.structure),
    words,
    chatMessages
  )
  if (!choice) return pickStructure(signals, words, clipStartSec)
  return pickStructure(signals, words, clipStartSec, choice)
}
