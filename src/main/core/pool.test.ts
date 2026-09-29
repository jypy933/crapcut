import { describe, expect, it } from 'vitest'
import { CancelledError } from '../util/errors'
import { runPool } from './pool'

const tick = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** A promise that is settled by hand, to control which item finishes when. */
function gate<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void
  let reject!: (e: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('runPool', () => {
  it('keeps results in input order however the items finish', async () => {
    const delays = [30, 5, 20, 1, 10]
    const { results, failures } = await runPool(delays, async (d, i) => {
      await tick(d)
      return `r${i}`
    }, { concurrency: 3, maxFailures: 3 })
    expect(results).toEqual(['r0', 'r1', 'r2', 'r3', 'r4'])
    expect(failures).toBe(0)
  })

  it('never runs more than the allowed number at once and starts items in order', async () => {
    let running = 0
    let peak = 0
    const started: number[] = []
    await runPool(Array.from({ length: 9 }, (_, i) => i), async (_, i) => {
      started.push(i)
      running++
      peak = Math.max(peak, running)
      await tick(3)
      running--
    }, { concurrency: 2, maxFailures: 3 })
    expect(peak).toBe(2)
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8])
  })

  it('with one lane behaves like a plain loop', async () => {
    const order: number[] = []
    await runPool([1, 2, 3], async (n) => {
      order.push(n)
      await tick(1)
      order.push(-n)
    }, { concurrency: 1, maxFailures: 3 })
    expect(order).toEqual([1, -1, 2, -2, 3, -3])
  })

  it('reports progress that only goes up and ends at the total', async () => {
    const seen: number[] = []
    await runPool([20, 1, 10, 5], (d) => tick(d), { concurrency: 3, maxFailures: 3, onSettled: (n, total) => seen.push(n / total) })
    expect(seen).toEqual([0.25, 0.5, 0.75, 1])
  })

  it('stops starting new items after the allowed number of failures and keeps finished results', async () => {
    const started: number[] = []
    const gates = Array.from({ length: 8 }, () => gate<string>())
    const failed: number[] = []
    const pool = runPool(gates, async (g, i) => {
      started.push(i)
      return g.promise
    }, { concurrency: 3, maxFailures: 3, onFailure: (_, i) => failed.push(i) })
    await tick(1)
    expect(started).toEqual([0, 1, 2])
    gates[1]!.resolve('ok1')
    await tick(1)
    expect(started).toEqual([0, 1, 2, 3])
    gates[0]!.reject(new Error('a'))
    gates[2]!.reject(new Error('b'))
    await tick(1)
    // Two failures so far: the pool is still scheduling.
    expect(started).toEqual([0, 1, 2, 3, 4, 5])
    gates[3]!.reject(new Error('c'))
    // A request already in flight when the third failure lands still finishes and is kept.
    gates[4]!.resolve('ok4')
    gates[5]!.resolve('ok5')
    const r = await pool
    expect(r.failures).toBe(3)
    expect(r.stoppedEarly).toBe(true)
    expect(r.results).toEqual([undefined, 'ok1', undefined, undefined, 'ok4', 'ok5', undefined, undefined])
    expect(started).toEqual([0, 1, 2, 3, 4, 5])
    expect(failed).toEqual([0, 2, 3])
  })

  it('counts failures across running items, not per lane', async () => {
    const r = await runPool(Array.from({ length: 10 }, (_, i) => i), async (i) => {
      await tick(1)
      if (i < 3) throw new Error('down')
      return i
    }, { concurrency: 3, maxFailures: 3 })
    expect(r.failures).toBe(3)
    expect(r.stoppedEarly).toBe(true)
    expect(r.results.slice(0, 3)).toEqual([undefined, undefined, undefined])
    expect(r.results.slice(6)).toEqual([undefined, undefined, undefined, undefined])
  })

  it('does not call the last few failing items an early stop when nothing was left', async () => {
    const r = await runPool([1, 2, 3], async () => {
      throw new Error('down')
    }, { concurrency: 1, maxFailures: 3 })
    expect(r.failures).toBe(3)
    expect(r.stoppedEarly).toBe(false)
  })

  it('never stops for failures when the limit is infinite', async () => {
    const r = await runPool([1, 2, 3, 4, 5], async (n) => {
      if (n % 2) throw new Error('odd')
      return n
    }, { concurrency: 2, maxFailures: Infinity })
    expect(r.results).toEqual([undefined, 2, undefined, 4, undefined])
    expect(r.stoppedEarly).toBe(false)
  })

  it('rejects at once when the signal aborts, without waiting for running items', async () => {
    const ctl = new AbortController()
    const stuck = gate<void>()
    const pool = runPool([1, 2, 3, 4], () => stuck.promise, { concurrency: 2, maxFailures: 3, signal: ctl.signal })
    await tick(1)
    ctl.abort()
    await expect(pool).rejects.toBeInstanceOf(CancelledError)
  })

  it('rejects when the signal is already aborted, before starting anything', async () => {
    const ctl = new AbortController()
    ctl.abort()
    let started = 0
    await expect(
      runPool([1, 2], async () => {
        started++
      }, { concurrency: 2, maxFailures: 3, signal: ctl.signal })
    ).rejects.toBeInstanceOf(CancelledError)
    expect(started).toBe(0)
  })

  it('rejects when a running item throws a cancel, and starts nothing more', async () => {
    const started: number[] = []
    const pool = runPool([1, 2, 3, 4, 5, 6], async (n) => {
      started.push(n)
      await tick(2)
      if (n === 2) throw new CancelledError()
      return n
    }, { concurrency: 2, maxFailures: 3 })
    await expect(pool).rejects.toBeInstanceOf(CancelledError)
    await tick(10)
    expect(started.length).toBeLessThanOrEqual(4)
  })

  it('is fine with no items', async () => {
    const r = await runPool<number, number>([], async (n) => n, { concurrency: 3, maxFailures: 3 })
    expect(r).toEqual({ results: [], failures: 0, stoppedEarly: false })
  })

  it('does not report progress after a cancel', async () => {
    const ctl = new AbortController()
    const seen: number[] = []
    const pool = runPool([1, 2, 3], async () => {
      await tick(5)
    }, { concurrency: 3, maxFailures: 3, signal: ctl.signal, onSettled: (n) => seen.push(n) })
    ctl.abort()
    await expect(pool).rejects.toBeInstanceOf(CancelledError)
    await tick(20)
    expect(seen).toEqual([])
  })
})
