// Confirms the exporter and the best-of builder actually share one encode
// lane: a full export and a best-of build must never run at the same time,
// since both are a full FFmpeg encode (and possibly stem separation).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Clip, ExportItem, HardwareProfile } from '@shared/types'
import type { AppPaths } from '../paths'
import { Store } from '../store'
import type { ToolRegistry } from '../tools/registry'
import { BestOfBuilder } from './bestOf'
import { Exporter } from './exporter'
import { GpuLock } from './gpuLock'

const hw: HardwareProfile = { gpus: [], primary: null, whisper: 'cpu', llm: 'cpu', totalRamMb: 8000, cpuThreads: 8 }
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const clip = (jobId: string): Clip => ({
  id: 'c1',
  jobId,
  rank: 1,
  score: 0.5,
  title: 'Clip 1',
  start: 0,
  end: 30,
  suggested: { start: 0, end: 30 },
  source: { start: 0, end: 30 },
  status: 'accepted',
  words: [],
  captions: { enabled: true, y: 0.7, uppercase: true, styleId: 'clean' },
  chatMessages: [],
  chatOverlay: false,
  audio: 'original',
  musicPath: null,
  layoutId: null,
  formats: { vertical: true, horizontal: false },
  reason: 'Chat spike',
  signals: null
})

let dir = ''
let store: Store
let paths: AppPaths

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crapcut-encodelock-'))
  store = new Store(join(dir, 'db.sqlite'))
  paths = { root: dir, tools: dir, downloads: dir, jobs: join(dir, 'jobs'), logs: dir, db: '', output: dir, resources: dir }
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('shared encode lock', () => {
  it('never overlaps an export and a best-of build', async () => {
    const encodeLock = new GpuLock()
    const exporter = new Exporter(store, paths, {} as ToolRegistry, () => hw, new GpuLock(), encodeLock, { onChanged: () => {} })
    const bestOf = new BestOfBuilder(store, paths, {} as ToolRegistry, exporter, encodeLock, { onChanged: () => {} })

    let concurrent = 0
    let maxConcurrent = 0
    const order: string[] = []
    const busy = async (label: string): Promise<string> => {
      concurrent++
      maxConcurrent = Math.max(maxConcurrent, concurrent)
      order.push(`${label}-start`)
      await wait(40)
      order.push(`${label}-end`)
      concurrent--
      return `${label}.mp4`
    }

    // Replace the real (I/O-heavy) work with fakes that just record overlap;
    // the lock itself is the thing under test here, not FFmpeg or captions.
    ;(exporter as unknown as { render: (item: ExportItem) => Promise<string> }).render = () => busy('export')
    ;(bestOf as unknown as { build: (jobId: string) => Promise<string> }).build = () => busy('bestof')

    const jobId = store.createJob('u', '1')
    store.replaceClips(jobId, [clip(jobId)])

    exporter.add(jobId, ['c1'])
    bestOf.start(jobId)

    for (let i = 0; i < 200; i++) {
      const exp = store.exports(jobId)[0]
      const bo = store.bestOfList(jobId)[0]
      if (exp?.status === 'done' && bo?.status === 'done') break
      await wait(5)
    }

    expect(store.exports(jobId)[0]).toMatchObject({ status: 'done' })
    expect(store.bestOfList(jobId)[0]).toMatchObject({ status: 'done' })
    expect(maxConcurrent).toBe(1)
    // One of them ran fully before the other started -- never interleaved.
    const startBeforeOtherEnd = order[1] === 'export-end' || order[1] === 'bestof-end'
    expect(startBeforeOtherEnd).toBe(true)
  })
})
