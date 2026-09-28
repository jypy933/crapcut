import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Clip } from '@shared/types'
import { Store } from './store'

let dir = ''
let store: Store

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crapcut-db-'))
  store = new Store(join(dir, 'test.db'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

const clip = (jobId: string, rank: number): Clip => ({
  id: `c${rank}`,
  jobId,
  rank,
  score: 0.5,
  title: `Clip ${rank}`,
  start: rank * 100,
  end: rank * 100 + 30,
  suggested: { start: rank * 100, end: rank * 100 + 30 },
  source: null,
  status: 'pending',
  words: [],
  captions: { enabled: true, y: 0.7, uppercase: true },
  audio: 'original',
  musicPath: null,
  layoutId: null,
  formats: { vertical: true, horizontal: false },
  reason: 'Chat spike'
})

describe('Store', () => {
  it('creates jobs with pending steps', () => {
    const id = store.createJob('https://www.twitch.tv/videos/1', '1')
    const job = store.job(id)!
    expect(job.status).toBe('queued')
    expect(job.currentStep).toBe('metadata')
    expect(Object.values(job.steps).every((s) => s.status === 'pending')).toBe(true)
    expect(store.findActiveJobForVod('1')).toBe(id)
  })

  it('tracks step progress and the current step', () => {
    const id = store.createJob('u', '2')
    store.setStep(id, 'metadata', { status: 'done', progress: 1 })
    store.setStep(id, 'chat', { status: 'running', progress: 0.5, etaSec: 30, detail: 'x' })
    const job = store.job(id)!
    expect(job.currentStep).toBe('chat')
    expect(job.steps.chat).toEqual({ status: 'running', progress: 0.5, etaSec: 30, detail: 'x' })
    store.resetStepsFrom(id, 'metadata')
    expect(store.job(id)!.steps.metadata.status).toBe('pending')
  })

  it('pauses jobs interrupted by a crash', () => {
    const id = store.createJob('u', '3')
    store.setJobStatus(id, 'running')
    store.setStep(id, 'audio', { status: 'running', progress: 0.4 })
    expect(store.markInterruptedJobs()).toEqual([id])
    const job = store.job(id)!
    expect(job.status).toBe('paused')
    expect(job.steps.audio.status).toBe('pending')
    // Progress is kept so resuming can show where it was.
    expect(job.steps.audio.progress).toBeCloseTo(0.4)
  })

  it('stores and edits clips', () => {
    const id = store.createJob('u', '4')
    store.replaceClips(id, [clip(id, 2), clip(id, 1)])
    expect(store.clips(id).map((c) => c.rank)).toEqual([1, 2])
    const c = store.clip('c1')!
    store.saveClip({ ...c, title: 'Edited', status: 'accepted' })
    expect(store.clip('c1')).toMatchObject({ title: 'Edited', status: 'accepted' })
    expect(store.job(id)!.clipCount).toBe(2)
  })

  it('deletes a job with its clips and exports', () => {
    const id = store.createJob('u', '5')
    store.replaceClips(id, [clip(id, 1)])
    store.addExport(id, 'c1', 'vertical')
    store.deleteJob(id)
    expect(store.job(id)).toBeNull()
    expect(store.clips(id)).toEqual([])
    expect(store.exports(id)).toEqual([])
  })

  it('tracks exports and requeues interrupted ones', () => {
    const id = store.createJob('u', '6')
    const e = store.addExport(id, 'c1', 'vertical')
    store.updateExport(e, { status: 'running', progress: 0.3, bogus: 1 } as never)
    store.requeueInterruptedExports()
    expect(store.exports(id)[0]).toMatchObject({ status: 'queued', progress: 0 })
  })

  it('saves layouts and settings', () => {
    store.saveLayout({ id: 'l1', name: 'Cam', kind: 'cam_game', cam: { x: 0.7, y: 0.7, w: 0.3, h: 0.3 }, game: { x: 0, y: 0, w: 1, h: 1 } })
    store.saveLayout({ id: 'l1', name: 'Cam 2', kind: 'cam_game', cam: null, game: { x: 0, y: 0, w: 1, h: 1 } })
    expect(store.layouts()).toHaveLength(1)
    expect(store.layout('l1')!.name).toBe('Cam 2')
    store.set('encoder', { id: 'h264_amf' })
    expect(store.get<{ id: string }>('encoder')).toEqual({ id: 'h264_amf' })
    expect(store.get('missing')).toBeNull()
  })

  it('reopens an existing database', () => {
    const id = store.createJob('u', '7')
    store.close()
    store = new Store(join(dir, 'test.db'))
    expect(store.job(id)).not.toBeNull()
  })
})
