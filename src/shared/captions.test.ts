import { describe, expect, it } from 'vitest'
import { isKeywordWord } from './captions'

describe('isKeywordWord', () => {
  it('flags shouted, all-caps words', () => {
    expect(isKeywordWord('STOP')).toBe(true)
    expect(isKeywordWord('OK')).toBe(true)
  })
  it('flags numbers', () => {
    expect(isKeywordWord('100')).toBe(true)
    expect(isKeywordWord('2nd')).toBe(true)
  })
  it('flags exclaimed words', () => {
    expect(isKeywordWord('really!')).toBe(true)
  })
  it('ignores ordinary lowercase and mixed-case words', () => {
    expect(isKeywordWord('watch')).toBe(false)
    expect(isKeywordWord("I'm")).toBe(false)
    expect(isKeywordWord('Chat')).toBe(false)
  })
  it('ignores empty or single-letter text', () => {
    expect(isKeywordWord('')).toBe(false)
    expect(isKeywordWord('  ')).toBe(false)
    expect(isKeywordWord('I')).toBe(false)
    expect(isKeywordWord('!')).toBe(false)
  })
})
