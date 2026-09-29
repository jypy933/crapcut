// A small concurrency pool for the language-model requests: a few run at once
// (llama-server serves them in parallel slots), results stay in input order,
// and a run of failures stops new work without throwing away what finished.

import { CancelledError, isCancelled } from '../util/errors'

export interface PoolOptions {
  /** How many items run at once. */
  concurrency: number
  /** Stop starting new items once this many have failed. */
  maxFailures: number
  signal?: AbortSignal
  /** After each item finishes (done or failed): how many have finished, of how many. Never goes down. */
  onSettled?: (settled: number, total: number) => void
  /** An item's work threw (anything but a cancel). */
  onFailure?: (error: unknown, index: number) => void
}

export interface PoolResult<R> {
  /** By input position; undefined for an item that failed or was never started. */
  results: (R | undefined)[]
  failures: number
  /** True when new work stopped because of `maxFailures`; items after that point were not started. */
  stoppedEarly: boolean
}

/**
 * Runs `work` on every item, at most `concurrency` at a time, starting them in
 * input order. A failed item leaves its slot in `results` empty and counts
 * against `maxFailures`; once that many have failed no new item is started
 * (the ones already running finish and keep their results). A cancel (the
 * signal aborting, or `work` throwing a cancel) rejects with `CancelledError`
 * right away, without waiting for running items.
 */
export async function runPool<T, R>(items: readonly T[], work: (item: T, index: number) => Promise<R>, opts: PoolOptions): Promise<PoolResult<R>> {
  const { signal } = opts
  if (signal?.aborted) throw new CancelledError()
  const total = items.length
  const results: (R | undefined)[] = new Array<R | undefined>(total).fill(undefined)
  let next = 0
  let failures = 0
  let settled = 0
  let cancelled = false
  let stoppedEarly = false

  const lane = async (): Promise<void> => {
    while (!cancelled && !stoppedEarly && !signal?.aborted) {
      const i = next++
      if (i >= total) return
      try {
        const value = await work(items[i]!, i)
        if (cancelled) return
        results[i] = value
      } catch (err) {
        if (cancelled) return
        if (isCancelled(err) || signal?.aborted) {
          cancelled = true
          throw new CancelledError()
        }
        failures++
        opts.onFailure?.(err, i)
        if (failures >= opts.maxFailures) stoppedEarly = true
      }
      settled++
      opts.onSettled?.(settled, total)
    }
  }

  let onAbort: (() => void) | undefined
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => reject(new CancelledError())
    signal?.addEventListener('abort', onAbort, { once: true })
  })
  aborted.catch(() => {})
  try {
    const lanes = Array.from({ length: Math.max(1, Math.min(Math.floor(opts.concurrency), total)) }, lane)
    await Promise.race([Promise.all(lanes), aborted])
  } catch (err) {
    cancelled = true
    throw err
  } finally {
    if (onAbort) signal?.removeEventListener('abort', onAbort)
  }
  // Failing on the very last items leaves nothing unstarted, so it is not an early stop.
  return { results, failures, stoppedEarly: stoppedEarly && next < total }
}
