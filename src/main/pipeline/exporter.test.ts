import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { Invoke } from '@shared/ipc'
import type { Clip, ExportItem, HardwareProfile } from '@shared/types'
import type { AppPaths } from '../paths'
import { Store } from '../store'
import type { ToolRegistry } from '../tools/registry'
import { Exporter, exportFileName } from './exporter'
import { GpuLock } from './gpuLock'

const clip = { rank: 3, title: 'He did NOT see that coming' } as Clip

describe('exportFileName', () => {
  it('names the platform', () => {
    expect(exportFileName(clip, 'vertical', 'tiktok')).toBe('03 He did NOT see that coming (TikTok).mp4')
    expect(exportFileName(clip, 'vertical', 'shorts')).toBe('03 He did NOT see that coming (Shorts).mp4')
    expect(exportFileName(clip, 'vertical', 'reels')).toBe('03 He did NOT see that coming (Reels).mp4')
  })

  it('keeps the old wording for 16:9 and for an export without a platform', () => {
    expect(exportFileName(clip, 'horizontal')).toBe('03 He did NOT see that coming (16x9).mp4')
    expect(exportFileName(clip, 'vertical')).toBe('03 He did NOT see that coming (9x16).mp4')
  })

  it('says cold open for that version, so both versions can sit side by side', () => {
    expect(exportFileName(clip, 'vertical', 'reels', 'coldOpen')).toBe('03 He did NOT see that coming (Reels cold open).mp4')
    expect(exportFileName(clip, 'horizontal', null, 'coldOpen')).toBe('03 He did NOT see that coming (16x9 cold open).mp4')
    expect(exportFileName(clip, 'vertical', 'reels', 'straight')).toBe(exportFileName(clip, 'vertical', 'reels'))
  })
})

describe('platform settings requests', () => {
  it('accepts one to three known platforms, nothing else', () => {
    const schema = Invoke['settings:setExportPlatforms']
    expect(schema.safeParse([['tiktok', 'reels']]).success).toBe(true)
    expect(schema.safeParse([[]]).success).toBe(false)
    expect(schema.safeParse([['tiktok', 'shorts', 'reels', 'tiktok']]).success).toBe(false)
    expect(schema.safeParse([['instagram']]).success).toBe(false)
    expect(schema.safeParse([]).success).toBe(false)
  })
})

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('Exporter per platform', () => {
  let dir = ''
  let store: Store
  let exporter: Exporter

  const makeClip = (jobId: string, formats: Clip['formats']): Clip => ({
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
    formats,
    reason: 'Chat spike',
    signals: null,
    structureDecision: null,
    autoEdit: true
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crapcut-exporter-'))
    store = new Store(join(dir, 'db.sqlite'))
    const hw: HardwareProfile = { gpus: [], primary: null, whisper: 'cpu', llm: 'cpu', totalRamMb: 8000, cpuThreads: 8 }
    const paths: AppPaths = { root: dir, tools: dir, downloads: dir, jobs: join(dir, 'jobs'), logs: dir, db: '', output: dir, resources: dir }
    exporter = new Exporter(store, paths, {} as ToolRegistry, () => hw, new GpuLock(), new GpuLock(), { onChanged: () => {} })
  })

  afterEach(async () => {
    await exporter.shutdown()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  /** Replaces the real render: platforms named in `left` come back left out, the others produce a file. */
  const fakeRender = (left: string[] = []): void => {
    ;(exporter as unknown as { render: (item: ExportItem) => Promise<{ file: string | null; note: string | null }> }).render = async (item) =>
      item.platform && left.includes(item.platform) ? { file: null, note: 'Not made.' } : { file: `${item.platform ?? item.format}.mp4`, note: null }
  }

  const settle = async (jobId: string): Promise<ExportItem[]> => {
    for (let i = 0; i < 200 && store.exports(jobId).some((e) => e.status === 'queued' || e.status === 'running'); i++) await wait(5)
    return store.exports(jobId)
  }

  it('starts with all three platforms and remembers the choice, never empty', () => {
    expect(exporter.platforms()).toEqual(['tiktok', 'shorts', 'reels'])
    expect(exporter.setPlatforms(['reels', 'tiktok'])).toEqual(['tiktok', 'reels'])
    expect(exporter.platforms()).toEqual(['tiktok', 'reels'])
    expect(exporter.setPlatforms([])).toEqual(['tiktok', 'shorts', 'reels'])
  })

  it('queues one vertical export per ticked platform and one for 16:9', async () => {
    fakeRender()
    const jobId = store.createJob('u', '1')
    store.replaceClips(jobId, [makeClip(jobId, { vertical: true, horizontal: true })])
    exporter.setPlatforms(['tiktok', 'reels'])
    exporter.add(jobId, ['c1'])
    const items = await settle(jobId)
    expect(items.map((e) => [e.format, e.platform, e.status])).toEqual([
      ['vertical', 'tiktok', 'done'],
      ['vertical', 'reels', 'done'],
      ['horizontal', null, 'done']
    ])
  })

  it('finishes a platform that was left out as done without a file, with its note', async () => {
    fakeRender(['shorts'])
    const jobId = store.createJob('u', '2')
    store.replaceClips(jobId, [makeClip(jobId, { vertical: true, horizontal: false })])
    exporter.add(jobId, ['c1'])
    const items = await settle(jobId)
    expect(items.find((e) => e.platform === 'shorts')).toMatchObject({ status: 'done', file: null, note: 'Not made.' })
    expect(items.find((e) => e.platform === 'tiktok')).toMatchObject({ status: 'done', file: 'tiktok.mp4', note: null })
  })
})
