// Runs the whole best-of builder (real store, real FFmpeg, generated sources):
// prep per clip, the one encode, the output file, cancel, and the encoder
// fallback. Skips cleanly when FFmpeg is not on PATH.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { BestOfItem, Clip, HardwareProfile } from '@shared/types'
import type { AppPaths } from '../paths'
import { Store } from '../store'
import { runTool } from '../tools/process'
import type { ToolRegistry } from '../tools/registry'
import { BestOfBuilder } from './bestOf'
import { Exporter } from './exporter'
import { GpuLock } from './gpuLock'
import { probeMedia } from './media'

function findOnPath(name: string): string | null {
  try {
    const out = execFileSync('where', [name], { encoding: 'utf8' })
    return out.split(/\r?\n/).find((l) => l.trim())?.trim() || null
  } catch {
    return null
  }
}

// The builder finds ffprobe next to ffmpeg.exe, like the installed tools; only a Windows dev PC has that layout.
const ffmpeg = process.platform === 'win32' ? findOnPath('ffmpeg.exe') : null
const ffprobe = process.platform === 'win32' ? findOnPath('ffprobe.exe') : null

const hw: HardwareProfile = { gpus: [], primary: null, whisper: 'cpu', llm: 'cpu', totalRamMb: 8000, cpuThreads: 8 }
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

const words = (from: number, to: number): Clip['words'] => Array.from({ length: to - from }, (_, i) => ({ t0: from + i, t1: from + i + 0.8, text: `word${i}` }))

const clip = (jobId: string, id: string, over: Partial<Clip>): Clip => ({
  id,
  jobId,
  rank: 1,
  score: 0.5,
  title: id,
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
  signals: null,
  structureDecision: null,
  autoEdit: true,
  ...over
})

let dir = ''
let store: Store
let paths: AppPaths
let jobId = ''

async function makeSource(file: string, seconds: number, size: string, rate: number, silent = false): Promise<void> {
  const args = ['-hide_banner', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`]
  if (!silent) args.push('-f', 'lavfi', '-i', `sine=frequency=440:sample_rate=48000:duration=${seconds}`, '-c:a', 'aac')
  await runTool(ffmpeg!, [...args, '-shortest', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', file])
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crapcut-bestof-build-'))
  store = new Store(join(dir, 'db.sqlite'))
  paths = { root: dir, tools: dir, downloads: dir, jobs: join(dir, 'jobs'), logs: dir, db: '', output: join(dir, 'out'), resources: join(process.cwd(), 'resources') }
  jobId = store.createJob('https://www.twitch.tv/videos/1', '1')
  mkdirSync(join(paths.jobs, jobId, 'clips'), { recursive: true })
  writeFileSync(
    join(paths.jobs, jobId, 'meta.json'),
    JSON.stringify({ vod: { id: '1', title: 'Test stream', channel: 'someone', durationSec: 600, createdAt: null, thumbnailUrl: null }, chapters: [], mutedFromPlaylist: [] })
  )
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

/** A builder with the real exporter behind it, using the given (cached) encoder choice. */
function makeBuilder(encoder: 'libx264' | 'h264_nvenc' = 'libx264'): BestOfBuilder {
  store.set('encoder', { encoder, gpu: null })
  const tools = { require: () => ffmpeg!, path: () => null } as unknown as ToolRegistry
  const lock = new GpuLock()
  const exporter = new Exporter(store, paths, tools, () => hw, new GpuLock(), lock, { onChanged: () => {} })
  return new BestOfBuilder(store, paths, tools, exporter, lock, { onChanged: () => {} })
}

async function until(fn: () => boolean, ms = 60_000): Promise<void> {
  for (let t = 0; t < ms && !fn(); t += 20) await wait(20)
}

const item = (): BestOfItem => store.bestOfList(jobId)[0]!
const workFolders = (): string[] => {
  const render = join(paths.jobs, jobId, 'render')
  return existsSync(render) ? readdirSync(render).filter((n) => n.startsWith('bestof-')) : []
}

describe.skipIf(!ffmpeg || !ffprobe)('best-of builder (real FFmpeg)', () => {
  it('prepares each clip, encodes once and leaves one finished file and no scratch files', async () => {
    // Sources are padded around the clip like real section downloads: the clip is 4 s starting 2 s in.
    await makeSource(join(paths.jobs, jobId, 'clips', 'c1.mp4'), 8, '1920x1080', 60)
    await makeSource(join(paths.jobs, jobId, 'clips', 'c2.mp4'), 8, '1280x720', 25)
    await makeSource(join(paths.jobs, jobId, 'clips', 'c3.mp4'), 8, '1920x1080', 30, true)
    store.replaceClips(jobId, [
      clip(jobId, 'c1', { rank: 2, start: 102, end: 106, source: { start: 100, end: 108 }, words: words(102, 106) }),
      clip(jobId, 'c2', { rank: 1, start: 301, end: 306, source: { start: 300, end: 308 }, words: words(301, 306) }),
      clip(jobId, 'c3', { rank: 3, start: 500, end: 504, source: { start: 498, end: 506 }, captions: { enabled: false, y: 0.7, uppercase: true, styleId: 'clean' } })
    ])

    const builder = makeBuilder()
    builder.start(jobId)
    await until(() => item().status === 'done' || item().status === 'failed')

    expect(item()).toMatchObject({ status: 'done', progress: 1 })
    const file = item().file!
    expect(file.endsWith('(16x9).mp4')).toBe(true)
    expect(file).toContain(join(dir, 'out'))
    const out = await probeMedia(ffprobe!, file)
    expect(out.width).toBe(1920)
    expect(out.height).toBe(1080)
    expect(out.hasAudio).toBe(true)
    // 4 + 5 + 4 s, minus two 0.5 s crossfades, in stream order.
    expect(out.duration).toBeGreaterThan(12 - 0.15)
    expect(out.duration).toBeLessThan(12 + 0.15)
    expect(workFolders()).toEqual([])
  }, 120_000)

  it('falls back to libx264 when the hardware encoder fails', async () => {
    await makeSource(join(paths.jobs, jobId, 'clips', 'c1.mp4'), 6, '1920x1080', 30)
    store.replaceClips(jobId, [clip(jobId, 'c1', { start: 2, end: 5, source: { start: 0, end: 6 } })])

    // NVENC needs an NVIDIA GPU; where it does work, the build simply succeeds first time.
    const builder = makeBuilder('h264_nvenc')
    builder.start(jobId)
    await until(() => item().status === 'done' || item().status === 'failed')
    expect(item().status).toBe('done')
    const out = await probeMedia(ffprobe!, item().file!)
    expect(out.duration).toBeGreaterThan(2.85)
    expect(out.duration).toBeLessThan(3.15)
  }, 120_000)

  it('stops the encode on cancel and removes its scratch files', async () => {
    // Long enough that the encode is still running when the cancel arrives.
    await makeSource(join(paths.jobs, jobId, 'clips', 'c1.mp4'), 40, '1920x1080', 60)
    await makeSource(join(paths.jobs, jobId, 'clips', 'c2.mp4'), 40, '1920x1080', 60)
    store.replaceClips(jobId, [
      clip(jobId, 'c1', { start: 100, end: 135, source: { start: 100, end: 140 } }),
      clip(jobId, 'c2', { start: 300, end: 335, source: { start: 300, end: 340 } })
    ])

    const builder = makeBuilder()
    const id = builder.start(jobId)
    // The output file appears once FFmpeg is running the encode.
    await until(() => workFolders().some((f) => existsSync(join(paths.jobs, jobId, 'render', f, 'out.mp4'))))
    expect(workFolders()).toHaveLength(1)
    builder.cancel(id)
    await until(() => item().status === 'cancelled')

    expect(item().status).toBe('cancelled')
    // The work folder goes as soon as the build unwinds.
    await until(() => workFolders().length === 0, 10_000)
    expect(workFolders()).toEqual([])
    expect(existsSync(join(dir, 'out'))).toBe(false)
  }, 120_000)

  it('turns down a best-of with too many clips before doing any work', () => {
    const many = Array.from({ length: 51 }, (_, i) => clip(jobId, `c${i}`, { rank: i + 1, start: i * 100, end: i * 100 + 10, source: { start: i * 100, end: i * 100 + 10 } }))
    store.replaceClips(jobId, many)
    const builder = makeBuilder()
    expect(() => builder.start(jobId)).toThrow(/up to 50 clips/)
    expect(store.bestOfList(jobId)).toHaveLength(0)
  })
})
