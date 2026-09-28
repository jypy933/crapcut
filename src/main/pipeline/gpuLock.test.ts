import { describe, expect, it } from 'vitest'
import { GpuLock } from './gpuLock'

describe('GpuLock', () => {
  it('runs holders one at a time in order', async () => {
    const lock = new GpuLock()
    const order: string[] = []
    const a = await lock.acquire()
    const pb = lock.acquire().then((rel) => {
      order.push('b')
      rel()
    })
    order.push('a')
    a()
    await pb
    expect(order).toEqual(['a', 'b'])
  })

  it('lets a waiter cancel without blocking the queue', async () => {
    const lock = new GpuLock()
    const a = await lock.acquire()
    const ac = new AbortController()
    const b = lock.acquire(ac.signal)
    const c = lock.acquire()
    ac.abort()
    await expect(b).rejects.toThrow('cancelled')
    a()
    const relC = await c
    relC()
  })
})
