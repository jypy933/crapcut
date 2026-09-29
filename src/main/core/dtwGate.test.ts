import { describe, expect, it, vi } from 'vitest'
import { DtwGate, MAX_DTW_FAILURES, runWithDtwFallback } from './dtwGate'

const isCancel = (err: unknown): boolean => err instanceof Error && err.name === 'Cancelled'

describe('runWithDtwFallback', () => {
  it('runs once with DTW when it works', async () => {
    const run = vi.fn(async (dtw: string | null) => `ran ${dtw}`)
    const onRetry = vi.fn()
    expect(await runWithDtwFallback('small', run, isCancel, onRetry)).toEqual({ result: 'ran small', dtw: true, retried: false })
    expect(run).toHaveBeenCalledTimes(1)
    expect(onRetry).not.toHaveBeenCalled()
  })

  it('runs once without DTW when none is asked for', async () => {
    const run = vi.fn(async (dtw: string | null) => `ran ${dtw}`)
    expect(await runWithDtwFallback(null, run, isCancel, () => {})).toEqual({ result: 'ran null', dtw: false, retried: false })
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('redoes a failed run without DTW and says so', async () => {
    const boom = new Error('whisper crashed')
    const run = vi.fn(async (dtw: string | null) => {
      if (dtw) throw boom
      return 'plain'
    })
    const onRetry = vi.fn()
    expect(await runWithDtwFallback('large.v3.turbo', run, isCancel, onRetry)).toEqual({ result: 'plain', dtw: false, retried: true })
    expect(run.mock.calls.map((c) => c[0])).toEqual(['large.v3.turbo', null])
    expect(onRetry).toHaveBeenCalledWith(boom)
  })

  it('throws the second error when the run fails without DTW too', async () => {
    const run = async (dtw: string | null): Promise<string> => {
      throw new Error(dtw ? 'with dtw' : 'without dtw')
    }
    await expect(runWithDtwFallback('small', run, isCancel, () => {})).rejects.toThrow('without dtw')
  })

  it('does not redo a cancelled run', async () => {
    const cancelled = Object.assign(new Error('cancelled'), { name: 'Cancelled' })
    const run = vi.fn(async () => {
      throw cancelled
    })
    await expect(runWithDtwFallback('small', run, isCancel, () => {})).rejects.toBe(cancelled)
    expect(run).toHaveBeenCalledTimes(1)
  })
})

describe('DtwGate', () => {
  it('keeps asking for DTW until it has failed a couple of times, then stops, saying so once', () => {
    const gate = new DtwGate()
    expect(gate.enabled).toBe(true)
    const said: boolean[] = []
    for (let i = 0; i < MAX_DTW_FAILURES + 2; i++) said.push(gate.failed())
    expect(said).toEqual([false, true, false, false])
    expect(gate.enabled).toBe(false)
  })
})
