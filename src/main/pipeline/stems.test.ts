import { mkdirSync, mkdtempSync, readdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { HardwareProfile } from '@shared/types'
import type { ToolRegistry } from '../tools/registry'
import type { GpuLock } from './gpuLock'

// A stand-in for FFmpeg and the separator: FFmpeg's WAV export is a no-op, and
// the separator writes its two output files into the work folder.
const runs: string[] = []
vi.mock('../tools/process', async (orig) => ({
  ...(await orig<typeof import('../tools/process')>()),
  runTool: vi.fn(async (file: string, args: string[], opts: { cwd?: string }) => {
    if (file === 'separator.exe') {
      runs.push(file)
      writeFileSync(join(opts.cwd!, args[2]!), 'voice')
      writeFileSync(join(opts.cwd!, args[3]!), 'background')
    }
    return { code: 0, stdout: '', stderr: '' }
  })
}))

import { cachedLoudness, prepareStems, separatorProgress, separatorThreads, stemCacheKey, type StemCache, type StemOptions } from './stems'

describe('separator helpers', () => {
  it('uses up to 8 threads', () => {
    expect(separatorThreads(16)).toBe(8)
    expect(separatorThreads(8)).toBe(4)
    expect(separatorThreads(2)).toBe(2)
    expect(separatorThreads(64)).toBe(8)
  })

  it('averages per-thread progress', () => {
    const p = separatorProgress(2)
    expect(p('Loaded model')).toBeNull()
    expect(p('[THREAD 0] ( 50.000%) Freq: decoder 3')).toBeCloseTo(0.25)
    expect(p('[THREAD 1] (100.000%) mix: 2, 343980')).toBeCloseTo(0.75)
    expect(p('[THREAD 7] ( 10.000%) out of range')).toBeCloseTo(0.75)
  })
})

describe('stem cache', () => {
  let root: string
  let input: string
  beforeEach(() => {
    runs.length = 0
    root = mkdtempSync(join(tmpdir(), 'crapcut-stems-'))
    input = join(root, 'clip.mp4')
    writeFileSync(input, 'video')
  })
  afterEach(() => rmSync(root, { recursive: true, force: true }))

  const tools = { path: (name: string) => (name === 'separator' ? 'separator.exe' : name === 'model-demucs' ? join('models', 'demucs.bin') : null) } as unknown as ToolRegistry
  const hw = { cpuThreads: 8, whisper: 'cuda' } as unknown as HardwareProfile
  const gpu = { acquire: async () => () => {} } as unknown as GpuLock

  const options = (workDir: string, cache: StemCache): StemOptions => {
    mkdirSync(workDir, { recursive: true })
    return { ffmpeg: 'ffmpeg.exe', tools, hw, gpu, input, seek: 1, duration: 20, workDir, cache, signal: new AbortController().signal, onProgress: () => {} }
  }
  const cacheFor = (seek = 1, duration = 20): StemCache => ({ dir: join(root, 'stems'), clipId: 'clip-a', key: stemCacheKey(seek, duration, input) })

  it('separates once when the same clip is rendered twice (a second format)', async () => {
    const first = await prepareStems(options(join(root, 'work-vertical'), cacheFor()))
    // The exporter wipes the work folder between renders.
    rmSync(join(root, 'work-vertical'), { recursive: true, force: true })
    const second = await prepareStems(options(join(root, 'work-horizontal'), cacheFor()))
    expect(runs).toHaveLength(1)
    expect(second).toEqual(first)
    expect(readdirSync(join(root, 'stems')).sort()).toHaveLength(2)
  })

  it('separates again when the cut or the source file changed, dropping the old entry', async () => {
    await prepareStems(options(join(root, 'work-1'), cacheFor()))
    await prepareStems(options(join(root, 'work-2'), cacheFor(1, 25)))
    expect(runs).toHaveLength(2)
    expect(readdirSync(join(root, 'stems'))).toHaveLength(2)

    writeFileSync(input, 'a different, longer download')
    utimesSync(input, new Date(0), new Date(86_400_000))
    await prepareStems(options(join(root, 'work-3'), cacheFor(1, 25)))
    expect(runs).toHaveLength(3)
  })

  it('caches the loudness measurement the same way', async () => {
    const m = { inputI: -20, inputTp: -3, inputLra: 5, inputThresh: -30, targetOffset: 0.5 }
    const measure = vi.fn(async () => m)
    expect(await cachedLoudness(cacheFor(), measure)).toEqual(m)
    expect(await cachedLoudness(cacheFor(), measure)).toEqual(m)
    expect(measure).toHaveBeenCalledTimes(1)

    // A failed measurement is not cached.
    const failing = vi.fn(async () => null)
    expect(await cachedLoudness(cacheFor(1, 30), failing)).toBeNull()
    expect(await cachedLoudness(cacheFor(1, 30), failing)).toBeNull()
    expect(failing).toHaveBeenCalledTimes(2)
  })
})
