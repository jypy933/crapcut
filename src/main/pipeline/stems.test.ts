import { describe, expect, it } from 'vitest'
import { separatorProgress, separatorThreads } from './stems'

describe('separator helpers', () => {
  it('uses up to 8 threads', () => {
    expect(separatorThreads(16)).toBe(8)
    expect(separatorThreads(8)).toBe(4)
    expect(separatorThreads(2)).toBe(2)
    expect(separatorThreads(64)).toBe(8)
  })

  it('averages per-thread progress', () => {
    const p = separatorProgress(2)
    expect(p('Loaded model')).toBeNull()
    expect(p('[THREAD 0] ( 50.000%) Freq: decoder 3')).toBeCloseTo(0.25)
    expect(p('[THREAD 1] (100.000%) mix: 2, 343980')).toBeCloseTo(0.75)
    expect(p('[THREAD 7] ( 10.000%) out of range')).toBeCloseTo(0.75)
  })
})
