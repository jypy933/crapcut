import { describe, expect, it } from 'vitest'
import type { ChatMessage, Word } from '@shared/types'
import { buildStructurePrompt, chatIndexLines, parseStructureAnswer, pickStructureWithLlm, STRUCTURE_ANSWER_SCHEMA, wordIndexLines } from './structureLlm'
import { scoreStructures, type StructureScore } from './structurePick'
import type { StructureSignals } from './structureSignals'

function signals(partial: Partial<StructureSignals>): StructureSignals {
  return {
    clipLength: 20,
    peakRatio: 0.5,
    setupLength: 10,
    quotableSpans: [],
    chatRateRatio: 0,
    silenceRatio: 0.1,
    subPeaks: 1,
    subPeakTimes: [],
    chatLeadSec: 0,
    ...partial
  }
}

const words: Word[] = [
  { t0: 0, t1: 0.3, text: 'no' },
  { t0: 0.3, t1: 0.6, text: 'way' },
  { t0: 0.6, t1: 0.9, text: 'he' },
  { t0: 0.9, t1: 1.2, text: 'actually' },
  { t0: 1.2, t1: 1.5, text: 'hit' },
  { t0: 1.5, t1: 1.8, text: 'that.' }
]

const chat: ChatMessage[] = [
  { t: 1, user: 'a', text: 'KEKW' },
  { t: 1.2, user: 'b', text: 'no way' },
  { t: 1.4, user: 'c', text: 'LOL' }
]

describe('wordIndexLines', () => {
  it('indexes each line by its first word, split at pauses', () => {
    const gapped: Word[] = [...words, { t0: 5, t1: 5.3, text: 'later' }]
    expect(wordIndexLines(gapped)).toEqual(['[0] no way he actually hit that.', '[6] later'])
  })
  it('returns nothing for no words', () => {
    expect(wordIndexLines([])).toEqual([])
  })
})

describe('chatIndexLines', () => {
  it('keeps each message at its real array index', () => {
    expect(chatIndexLines(chat)).toEqual(['0: "KEKW"', '1: "no way"', '2: "LOL"'])
  })
  it('caps at the limit', () => {
    expect(chatIndexLines(chat, 2)).toEqual(['0: "KEKW"', '1: "no way"'])
  })
})

describe('buildStructurePrompt', () => {
  const options: StructureScore[] = [
    { structure: 'quoteCard', score: 0.5, reasons: ['a clean verbatim line sits near the peak'] },
    { structure: 'buildAndPunch', score: 0.48, reasons: ['a single build-up leads into the payoff'] }
  ]

  it('lists options, indexed words and chat, few-shots and the JSON task', () => {
    const p = buildStructurePrompt(options, words, chat)
    expect(p).toContain('0: quoteCard')
    expect(p).toContain('1: buildAndPunch')
    expect(p).toContain('[0] no way he actually hit that.')
    expect(p).toContain('0: "KEKW"')
    expect(p).toContain('Example:')
    expect(p).toContain('JSON')
    expect(p).not.toMatch(/\bseconds from\b/)
  })

  it('says so when there is no chat', () => {
    expect(buildStructurePrompt(options, words, [])).toContain('No chat messages.')
  })
})

describe('parseStructureAnswer', () => {
  const options = ['quoteCard', 'buildAndPunch'] as const

  it('accepts a well-formed answer', () => {
    const raw = '{"optionIndex":0,"quoteStart":0,"quoteEnd":5,"emphasisWords":[0,1],"chatMessages":[0,2]}'
    const a = parseStructureAnswer(raw, [...options], words, chat)
    expect(a).toEqual({ structure: 'quoteCard', quoteSpan: { start: 0, end: 5 }, emphasisWords: [0, 1], chatMessageIds: [0, 2] })
  })

  it('rejects an out-of-range option index', () => {
    expect(parseStructureAnswer('{"optionIndex":5,"quoteStart":0,"quoteEnd":1,"emphasisWords":[],"chatMessages":[]}', [...options], words, chat)).toBeNull()
    expect(parseStructureAnswer('{"optionIndex":-1,"quoteStart":0,"quoteEnd":1,"emphasisWords":[],"chatMessages":[]}', [...options], words, chat)).toBeNull()
  })

  it('drops an out-of-range or too-long quote span but keeps the option pick', () => {
    const a = parseStructureAnswer('{"optionIndex":1,"quoteStart":0,"quoteEnd":99,"emphasisWords":[],"chatMessages":[]}', [...options], words, chat)
    expect(a).toEqual({ structure: 'buildAndPunch' })
  })

  it('drops a same-start-and-end quote span (the model saying "no quote")', () => {
    const a = parseStructureAnswer('{"optionIndex":0,"quoteStart":2,"quoteEnd":2,"emphasisWords":[],"chatMessages":[]}', [...options], words, chat)
    expect(a!.quoteSpan).toBeUndefined()
  })

  it('drops out-of-range emphasis and chat indices, keeps the valid ones', () => {
    const a = parseStructureAnswer('{"optionIndex":0,"quoteStart":0,"quoteEnd":0,"emphasisWords":[1,99,-1],"chatMessages":[0,50]}', [...options], words, chat)
    expect(a!.emphasisWords).toEqual([1])
    expect(a!.chatMessageIds).toEqual([0])
  })

  it('rejects malformed JSON and wrong-shaped answers', () => {
    expect(parseStructureAnswer('not json', [...options], words, chat)).toBeNull()
    expect(parseStructureAnswer('{"optionIndex":"zero"}', [...options], words, chat)).toBeNull()
    expect(parseStructureAnswer('{}', [...options], words, chat)).toBeNull()
  })

  it('tolerates text wrapped around the JSON', () => {
    const a = parseStructureAnswer('Sure, here: {"optionIndex":0,"quoteStart":0,"quoteEnd":0,"emphasisWords":[],"chatMessages":[]} done', [...options], words, chat)
    expect(a!.structure).toBe('quoteCard')
  })
})

describe('STRUCTURE_ANSWER_SCHEMA', () => {
  it('requires exactly the five fields and nothing else', () => {
    expect(STRUCTURE_ANSWER_SCHEMA.required).toEqual(['optionIndex', 'quoteStart', 'quoteEnd', 'emphasisWords', 'chatMessages'])
    expect(STRUCTURE_ANSWER_SCHEMA.additionalProperties).toBe(false)
  })
})

describe('pickStructureWithLlm', () => {
  it('never calls the model when the heuristic pick is clear-cut and spans do not tie', async () => {
    const s = signals({ peakRatio: 0.05, setupLength: 1 })
    let called = false
    const d = await pickStructureWithLlm({ signals: s, words, chatMessages: [] }, async () => {
      called = true
      return ''
    })
    expect(called).toBe(false)
    expect(d.structure).toBe('payoffFirst')
  })

  it('calls the model when two structures score within the tie margin and honours a valid answer', async () => {
    // quoteCard (a clean span, mid-clip peak) and chatFirst (capped conservatively) land close on purpose here.
    const s = signals({ clipLength: 25, peakRatio: 0.5, quotableSpans: [{ start: 0, end: 3 }], chatRateRatio: 5, chatLeadSec: 8 })
    const scored = scoreStructures(s)
    const ranked = [...scored].sort((a, b) => b.score - a.score)
    expect(ranked[0]!.structure).toBe('quoteCard')
    expect(ranked[0]!.score - ranked[1]!.score).toBeLessThanOrEqual(0.08)
    let seenPrompt = ''
    const d = await pickStructureWithLlm({ signals: s, words, chatMessages: chat }, async (prompt) => {
      seenPrompt = prompt
      return '{"optionIndex":0,"quoteStart":0,"quoteEnd":3,"emphasisWords":[0],"chatMessages":[0]}'
    })
    expect(seenPrompt).toContain('Options:')
    expect(d.quoteSpan).toEqual({ start: 0, end: 3 })
  })

  it('falls back to the heuristic pick when the model call throws', async () => {
    const s = signals({ clipLength: 25, peakRatio: 0.5, quotableSpans: [{ start: 0, end: 3 }] })
    const d = await pickStructureWithLlm({ signals: s, words, chatMessages: chat }, async () => {
      throw new Error('offline')
    })
    expect(d.structure).toBeDefined()
  })

  it('falls back to the heuristic pick when the model answer is unusable', async () => {
    const s = signals({ clipLength: 25, peakRatio: 0.5, quotableSpans: [{ start: 0, end: 3 }] })
    const d = await pickStructureWithLlm({ signals: s, words, chatMessages: chat }, async () => 'garbage')
    expect(d.structure).toBeDefined()
  })

  it('asks the model when there are several tied quotable spans even if scores are not close', async () => {
    const s = signals({ clipLength: 25, peakRatio: 0.85, quotableSpans: [{ start: 0, end: 3 }, { start: 4, end: 5 }] })
    let called = false
    await pickStructureWithLlm({ signals: s, words, chatMessages: [] }, async () => {
      called = true
      return '{"optionIndex":0,"quoteStart":0,"quoteEnd":3,"emphasisWords":[],"chatMessages":[]}'
    })
    expect(called).toBe(true)
  })
})
