import { homedir } from 'node:os'
import { describe, expect, it } from 'vitest'
import { redact } from './log'

describe('redact', () => {
  it('replaces the home folder in both slash styles', () => {
    const home = homedir()
    expect(redact(`open ${home}\\AppData\\x.wav`)).toBe('open ~\\AppData\\x.wav')
    expect(redact(`open ${home.replace(/\\/g, '/')}/x.wav`)).toBe('open ~/x.wav')
  })
  it('leaves other text alone', () => {
    expect(redact('nothing personal here')).toBe('nothing personal here')
  })
})
