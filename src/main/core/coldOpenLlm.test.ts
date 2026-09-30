import { describe, expect, it } from 'vitest'
import type { Word } from '@shared/types'
import { buildColdOpenPrompt, COLD_OPEN_ANSWER_SCHEMA, confirmColdOpen, parseColdOpenAnswer } from './coldOpenLlm'

const words: Word[] = [
  { t0: 0, t1: 0.3, text: 'okay' },
  { t0: 0.5, t1: 0.8, text: 'one' },
  { t0: 1, t1: 1.3, text: 'shot' },
  { t0: 10, t1: 10.3, text: 'YES' },
  { t0: 10.5, t1: 10.8, text: 'no' },
  { t0: 11, t1: 11.3, text: 'way' },
  { t0: 20, t1: 20.3, text: 'later' }
]

describe('buildColdOpenPrompt', () => {
  it('shows the words before the preview as the setup and the preview words verbatim, nothing else', () => {
    const prompt = buildColdOpenPrompt(words, { srcStart: 9.9, srcEnd: 11.5 })
    expect(prompt).toContain('Setup: "okay one shot"')
    expect(prompt).toContain('Preview: "YES no way"')
    expect(prompt).not.toContain('later')
  })

  it('says so when there is no speech', () => {
    expect(buildColdOpenPrompt([], { srcStart: 1, srcEnd: 2 })).toContain('Preview: "(no speech)"')
  })
})

describe('parseColdOpenAnswer', () => {
  it('reads a boolean and rejects anything else', () => {
    expect(parseColdOpenAnswer('{"worthIt": true}')).toBe(true)
    expect(parseColdOpenAnswer('noise {"worthIt": false} more')).toBe(false)
    expect(parseColdOpenAnswer('{"worthIt": "yes"}')).toBeNull()
    expect(parseColdOpenAnswer('not json')).toBeNull()
    expect(parseColdOpenAnswer('')).toBeNull()
  })

  it('has a schema that only allows the one boolean', () => {
    expect(COLD_OPEN_ANSWER_SCHEMA.required).toEqual(['worthIt'])
    expect(COLD_OPEN_ANSWER_SCHEMA.additionalProperties).toBe(false)
  })
})

describe('confirmColdOpen', () => {
  const span = { srcStart: 9.9, srcEnd: 11.5 }
  it('maps the answer to a verdict', async () => {
    expect(await confirmColdOpen(words, span, async () => '{"worthIt": true}')).toBe('confirmed')
    expect(await confirmColdOpen(words, span, async () => '{"worthIt": false}')).toBe('rejected')
  })

  it('is unavailable when the model fails or answers with nonsense, and never throws', async () => {
    expect(await confirmColdOpen(words, span, async () => Promise.reject(new Error('server down')))).toBe('unavailable')
    expect(await confirmColdOpen(words, span, async () => 'maybe')).toBe('unavailable')
  })
})
