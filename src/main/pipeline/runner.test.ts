import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { STEP_IDS, type HardwareProfile, type JobSummary, type StepId } from '@shared/types'
import type { AppPaths } from '../paths'
import { Store } from '../store'
import type { ToolRegistry } from '../tools/registry'
import { CancelledError, UserError } from '../util/errors'
import { GpuLock } from './gpuLock'
import { JobRunner } from './runner'
import type { StepContext } from './steps'

const hw: HardwareProfile = { gpus: [], primary: null, whisper: 'cpu', llm: 'cpu', totalRamMb: 8000, cpuThreads: 8 }

let dir = ''
let store: Store
let paths: AppPaths

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crapcut-runner-'))
  store = new Store(join(dir, 'db.sqlite'))
  paths = { root: dir, tools: dir, downloads: dir, jobs: join(dir, 'jobs'), logs: dir, db: '', output: dir, resources: dir }
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

type StepFn = (ctx: StepContext) => Promise<void>

function runner(steps: Partial<Record<StepId, StepFn>>, events: JobSummary[] = []): JobRunner {
  const ok: StepFn = async () => {}
  const all = Object.fromEntries(STEP_IDS.map((s) => [s, steps[s] ?? ok])) as Record<StepId, StepFn>
  return new JobRunner(store, paths, {} as ToolRegistry, () => hw, new GpuLock(), { onJobChanged: (j) => events.push(j), onJobReady: () => {} }, { steps: all, retryDelayMs: 1 })
}

async function settle(id: string, statuses: string[]): Promise<JobSummary> {
  for (let i = 0; i < 400; i++) {
    const j = store.job(id)!
    if (statuses.includes(j.status)) return j
    await new Promise((r) => setTimeout(r, 5))
  }
  throw new Error(`job stuck in ${store.job(id)!.status}`)
}

describe('JobRunner', () => {
  it('runs every step and ends ready for review', async () => {
    const order: StepId[] = []
    const make = (s: StepId): StepFn => async (ctx) => {
      ctx.progress(0.5)
      order.push(s)
    }
    const r = runner(Object.fromEntries(STEP_IDS.map((s) => [s, make(s)])))
    const id = store.createJob('https://www.twitch.tv/videos/1', '1')
    r.enqueue(id)
    const job = await settle(id, ['review'])
    expect(order).toEqual([...STEP_IDS])
    expect(Object.values(job.steps).every((s) => s.status === 'done' && s.progress === 1)).toBe(true)
  })

  it('retries network hiccups, then succeeds', async () => {
    let calls = 0
    const r = runner({
      chat: async () => {
        if (++calls < 3) throw new Error('socket hang up')
      }
    })
    const id = store.createJob('u', '2')
    r.enqueue(id)
    await settle(id, ['review'])
    expect(calls).toBe(3)
  })

  it('stops with one plain sentence when a step fails for good', async () => {
    const r = runner({ audio: async () => Promise.reject(new UserError('That VOD is for subscribers only.', { retryable: false })) })
    const id = store.createJob('u', '3')
    r.enqueue(id)
    const job = await settle(id, ['failed'])
    expect(job.error).toBe('That VOD is for subscribers only.')
    expect(job.steps.audio.status).toBe('failed')
    expect(job.steps.chat.status).toBe('done')
  })

  it('hides unexpected errors behind a friendly sentence', async () => {
    const r = runner({ transcribe: async () => Promise.reject(new TypeError('x is undefined')) })
    const id = store.createJob('u', '4')
    r.enqueue(id)
    const job = await settle(id, ['failed'])
    expect(job.error).toMatch(/^Something went wrong while transcribing\./)
  })

  it('retries a failed job from the failed step', async () => {
    let fail = true
    const seen: StepId[] = []
    const track =
      (s: StepId, f?: () => void): StepFn =>
      async () => {
        seen.push(s)
        f?.()
      }
    const r = runner({
      metadata: track('metadata'),
      moments: track('moments', () => {
        if (fail) throw new UserError('No moments.', { retryable: false })
      })
    })
    const id = store.createJob('u', '5')
    r.enqueue(id)
    await settle(id, ['failed'])
    fail = false
    seen.length = 0
    r.enqueue(id)
    await settle(id, ['review'])
    expect(seen).toEqual(['moments'])
  })

  it('pauses a running step and continues later', async () => {
    let started = false
    let runs = 0
    const r = runner({
      transcribe: (ctx) =>
        new Promise<void>((resolve, reject) => {
          runs++
          started = true
          if (runs > 1) return resolve()
          ctx.signal.addEventListener('abort', () => reject(new CancelledError()))
        })
    })
    const id = store.createJob('u', '6')
    r.enqueue(id)
    while (!started) await new Promise((res) => setTimeout(res, 5))
    r.pause(id)
    const paused = await settle(id, ['paused'])
    expect(paused.steps.transcribe.status).toBe('pending')
    expect(paused.steps.audio.status).toBe('done')
    r.enqueue(id)
    await settle(id, ['review'])
    expect(runs).toBe(2)
  })

  it('runs one job at a time in order', async () => {
    const active: string[] = []
    let overlap = false
    const r = runner({
      audio: async (ctx) => {
        if (active.length) overlap = true
        active.push(ctx.job.id)
        await new Promise((res) => setTimeout(res, 20))
        active.pop()
      }
    })
    const a = store.createJob('u', '7')
    const b = store.createJob('u', '8')
    r.enqueue(a)
    r.enqueue(b)
    expect(store.job(b)!.status).toBe('queued')
    await settle(a, ['review'])
    await settle(b, ['review'])
    expect(overlap).toBe(false)
  })

  it('cancels a queued job without running it', async () => {
    let ran = false
    const r = runner({
      audio: async (ctx) => {
        if (ctx.job.vodId === '10') ran = true
        await new Promise((res) => setTimeout(res, 30))
      }
    })
    const a = store.createJob('u', '9')
    const b = store.createJob('u', '10')
    r.enqueue(a)
    r.enqueue(b)
    r.cancel(b)
    await settle(a, ['review'])
    expect(store.job(b)!.status).toBe('cancelled')
    expect(ran).toBe(false)
  })
})
