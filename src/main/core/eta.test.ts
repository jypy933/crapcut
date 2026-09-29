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

describe('EtaEstimator trust and smoothing', () => {
  it('says nothing until it has watched long enough and seen enough progress', () => {
    let now = 0
    const eta = new EtaEstimator(30_000, () => now)
    expect(eta.update(0, 1000)).toBeNull()
    now = 4000
    expect(eta.update(400, 1000)).toBeNull() // a lot done, but only 4 s of watching
    now = 6000
    expect(eta.update(600, 1000)).not.toBeNull()

    now = 0
    const slow = new EtaEstimator(30_000, () => now)
    slow.update(0, 1000)
    now = 10_000
    expect(slow.update(2, 1000)).toBeNull() // 0.2 % is too little to trust
    now = 20_000
    expect(slow.update(20, 1000)).not.toBeNull()
  })

  it('does not jump when one sample bursts ahead', () => {
    let now = 0
    const eta = new EtaEstimator(30_000, () => now)
    let last: number | null = null
    for (let i = 0; i <= 20; i++) {
      now = i * 1000
      last = eta.update(i, 100) // 1 unit per second
    }
    expect(last).toBe(80)
    now = 21_000
    const burst = eta.update(31, 100) // 10 units in one second
    // The raw window rate would say about 50 s; smoothing keeps it well above that.
    expect(burst).toBeGreaterThan(60)
    expect(burst).toBeLessThan(80)
  })

  it('hides during a stall and only comes back once it has watched again', () => {
    let now = 0
    const eta = new EtaEstimator(30_000, () => now)
    for (let i = 0; i <= 10; i++) {
      now = i * 1000
      eta.update(i, 100)
    }
    now = 40_000 // nothing for 30 s
    expect(eta.update(10, 100)).toBeNull()
    now = 41_000
    expect(eta.update(11, 100)).toBeNull() // the stall is forgotten, so it starts watching afresh
    now = 47_000
    // Back on 1 unit per second, not dragged down by the stall.
    expect(eta.update(17, 100)).toBe(83)
  })

  it('starts over when progress goes backwards', () => {
    let now = 0
    const eta = new EtaEstimator(30_000, () => now)
    eta.update(0, 100)
    now = 10_000
    expect(eta.update(50, 100)).not.toBeNull()
    now = 11_000
    expect(eta.update(5, 100)).toBeNull()
  })

  it('is zero when done and null when the estimate is absurd', () => {
    let now = 0
    const eta = new EtaEstimator(30_000, () => now)
    eta.update(0, 1e9)
    now = 10_000
    expect(eta.update(1e9, 1e9)).toBe(0)
    now = 0
    const slow = new EtaEstimator(30_000, () => now)
    slow.update(0, 1e9)
    now = 10_000
    expect(slow.update(1e8, 1e9)).not.toBeNull()
    const tiny = new EtaEstimator(30_000, () => now, { minFraction: 0 })
    now = 20_000
    tiny.update(0, 1e9)
    now = 30_000
    expect(tiny.update(1, 1e9)).toBeNull() // years left
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
