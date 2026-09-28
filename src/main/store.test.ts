import { mkdtempSync, rmSync } from 'node:fs'
import { DatabaseSync } from 'node:sqlite'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Clip } from '@shared/types'
import { MIGRATIONS, Store } from './store'

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
  captions: { enabled: true, y: 0.7, uppercase: true, styleId: 'clean' },
  audio: 'original',
  musicPath: null,
  layoutId: null,
  formats: { vertical: true, horizontal: false },
  reason: 'Chat spike',
  signals: { chatZ: 3, audioZ: 0.5, score: 0.6, rating: null, source: 'chat' }
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

  it('tracks best-of builds and requeues interrupted ones', () => {
    const id = store.createJob('u', '7')
    const other = store.createJob('u', '8')
    store.addBestOf(other)
    const b = store.addBestOf(id)
    expect(store.bestOfList(id)).toMatchObject([{ status: 'queued', progress: 0 }])
    store.updateBestOf(b, { status: 'running', progress: 0.5 })
    expect(store.bestOfList(id)[0]).toMatchObject({ status: 'running', progress: 0.5 })
    store.requeueInterruptedBestOf()
    expect(store.bestOfList(id)[0]).toMatchObject({ status: 'queued', progress: 0 })
    expect(store.bestOfList()).toHaveLength(2)
    store.updateBestOf(b, { status: 'done', file: 'C:\\out\\best.mp4' })
    expect(store.bestOfList(id)[0]).toMatchObject({ status: 'done', file: 'C:\\out\\best.mp4' })
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

  it('records, updates and clears taste decisions', () => {
    const decision = { status: 'accepted' as const, signals: { chatZ: 3, audioZ: 0, score: 0.6, rating: null, source: 'chat' as const }, suggested: { start: 0, end: 30 }, final: { start: 0, end: 30 } }
    store.recordTasteDecision('c1', decision)
    store.recordTasteDecision('c2', { ...decision, status: 'rejected' })
    expect(store.getTasteHistory()).toHaveLength(2)

    // Recording again for the same clip replaces its entry, not adds another.
    store.recordTasteDecision('c1', { ...decision, final: { start: 2, end: 32 } })
    const history = store.getTasteHistory()
    expect(history).toHaveLength(2)
    expect(history.find((d) => d.status === 'accepted')!.final).toEqual({ start: 2, end: 32 })

    // Setting a clip back to pending removes it from history.
    store.recordTasteDecision('c1', null)
    expect(store.getTasteHistory()).toHaveLength(1)

    store.clearTasteHistory()
    expect(store.getTasteHistory()).toEqual([])
  })

  it('reopens an existing database', () => {
    const id = store.createJob('u', '7')
    store.close()
    store = new Store(join(dir, 'test.db'))
    expect(store.job(id)).not.toBeNull()
  })
})

describe('schema migration', () => {
  it('migrates a real v1 database (with existing rows) to v2 without losing data', () => {
    // Build the database exactly as the shipped v0.1.2 app would have left
    // it: only migration 1 applied, user_version = 1, real rows in it.
    const file = join(dir, 'v1.db')
    const raw = new DatabaseSync(file)
    raw.exec(MIGRATIONS[1]!)
    raw.exec('PRAGMA user_version = 1')
    const now = Date.now()
    raw.prepare('INSERT INTO jobs (id, url, vod_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run('job1', 'https://www.twitch.tv/videos/1', '1', 'review', now, now)
    raw.prepare('INSERT INTO steps (job_id, step, status) VALUES (?, ?, ?)').run('job1', 'metadata', 'done')
    const clipData = JSON.stringify({ ...clip('job1', 1), status: 'accepted' })
    raw.prepare('INSERT INTO clips (id, job_id, rank, data, updated_at) VALUES (?, ?, ?, ?, ?)').run('c1', 'job1', 1, clipData, now)
    raw.prepare('INSERT INTO exports (id, job_id, clip_id, format, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run('exp1', 'job1', 'c1', 'vertical', 'done', now)
    raw.prepare('INSERT INTO kv (key, value) VALUES (?, ?)').run('encoder', JSON.stringify({ encoder: 'libx264' }))
    raw.close()

    const migrated = new Store(file)
    try {
      // The pre-existing rows are all still there, untouched.
      expect(migrated.job('job1')).toMatchObject({ id: 'job1', status: 'review' })
      expect(migrated.clips('job1')).toHaveLength(1)
      expect(migrated.clip('c1')).toMatchObject({ id: 'c1', status: 'accepted' })
      expect(migrated.exports('job1')).toMatchObject([{ id: 'exp1', status: 'done' }])
      expect(migrated.get<{ encoder: string }>('encoder')).toEqual({ encoder: 'libx264' })

      // The new table from migration 2 exists and works.
      const b = migrated.addBestOf('job1')
      expect(migrated.bestOfList('job1')).toMatchObject([{ id: b, status: 'queued' }])

      const version = (migrated.db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version
      expect(version).toBe(2)
    } finally {
      migrated.close()
    }
  })
})
