import { describe, expect, it } from 'vitest'
import { formatBytes, formatClock, formatEta, formatLength } from '@shared/format'
import { EtaEstimator } from './eta'

describe('EtaEstimator', () => {
  it('estimates from the recent rate', () => {
    let now = 0
    const eta = new EtaEstimator(30_000, () => now)
    expect(eta.update(0, 100)).toBeNull()
    now = 1000
    expect(eta.update(1, 100)).toBeNull()
    now = 10_000
    expect(eta.update(10, 100)).toBe(90)
  })

  it('forgets old samples', () => {
    let now = 0
    const eta = new EtaEstimator(10_000, () => now)
    eta.update(0, 100)
    now = 5_000
    eta.update(50, 100) // fast start
    now = 20_000
    eta.update(55, 100)
    now = 30_000
    // Recent rate is slow (5 units in 10 s), so the estimate reflects that.
    expect(eta.update(60, 100)).toBeGreaterThan(60)
  })

  it('returns null when stalled', () => {
    let now = 0
    const eta = new EtaEstimator(30_000, () => now)
    eta.update(5, 10)
    now = 5000
    expect(eta.update(5, 10)).toBeNull()
  })
})

describe('formatEta', () => {
  it('reads naturally', () => {
    expect(formatEta(null)).toBeNull()
    expect(formatEta(20)).toBe('less than a minute')
    expect(formatEta(180)).toBe('about 3 min')
    expect(formatEta(3600)).toBe('about 1 h')
    expect(formatEta(4800)).toBe('about 1 h 20 min')
  })
  it('formats sizes and times', () => {
    expect(formatBytes(5198911904)).toBe('4.8 GB')
    expect(formatBytes(874188075)).toBe('834 MB')
    expect(formatBytes(0)).toBe('0 MB')
    expect(formatClock(3725.4)).toBe('1:02:05')
    expect(formatClock(65)).toBe('1:05')
    expect(formatLength(34.56)).toBe('34.6 s')
  })
})
