// Voice / background separation for the per-clip audio options. Runs Demucs
// (CrapCut's demucs.cpp build) on the chosen clip's audio at export, never on
// the whole stream. CPU only; about 2-3x the clip length on an 8-core CPU.

import { existsSync } from 'node:fs'
import { join, relative } from 'node:path'
import type { HardwareProfile } from '@shared/types'
import type { ToolRegistry } from '../tools/registry'
import { runTool, ToolFailedError } from '../tools/process'
import { UserError, isCancelled } from '../util/errors'
import { logger } from '../util/log'
import type { GpuLock } from './gpuLock'

const log = logger('stems')

export interface StemOptions {
  ffmpeg: string
  tools: ToolRegistry
  hw: HardwareProfile
  gpu: GpuLock
  input: string
  seek: number
  duration: number
  workDir: string
  signal: AbortSignal
  onProgress: (f: number) => void
}

export interface Stems {
  /** Absolute path of the voice-only WAV (clip length). */
  voice: string
  /** Absolute path of everything except the voice (clip length). */
  background: string
}

/** Windows exit code for "illegal instruction" (CPU without AVX2). */
const ILLEGAL_INSTRUCTION = 0xc000001d

export function stemsAvailable(tools: ToolRegistry): boolean {
  return !!tools.path('separator') && !!tools.path('model-demucs')
}

/** Threads for separation: more than 8 is slower (hyperthreads, efficiency cores). */
export function separatorThreads(cpuThreads: number): number {
  return Math.max(2, Math.min(8, Math.floor(cpuThreads / 2)))
}

/** Tracks "[THREAD i] ( 45.000%) ..." lines and returns overall progress 0..1. */
export function separatorProgress(threads: number): (line: string) => number | null {
  const per = new Array<number>(threads).fill(0)
  return (line) => {
    const m = /\[THREAD (\d+)\]\s*\(\s*([\d.]+)%\)/.exec(line)
    if (!m) return null
    const i = Number(m[1])
    if (i >= 0 && i < threads) per[i] = Math.min(1, Number(m[2]) / 100)
    return per.reduce((s, v) => s + v, 0) / threads
  }
}

export async function prepareStems(o: StemOptions): Promise<Stems> {
  const exe = o.tools.path('separator')
  const model = o.tools.path('model-demucs')
  if (!exe || !model) throw new UserError('Voice separation is not installed. Open setup to download it.', { retryable: false })

  // 1. The clip's audio as 44.1 kHz stereo WAV (what Demucs expects).
  await runTool(o.ffmpeg, ['-hide_banner', '-nostdin', '-y', '-ss', o.seek.toFixed(3), '-t', o.duration.toFixed(3), '-i', o.input, '-vn', '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s16le', 'stem-in.wav'], {
    cwd: o.workDir,
    signal: o.signal
  })
  o.onProgress(0.03)

  // 2. Separate. Paths are relative to the work folder (safe for any user name).
  const threads = separatorThreads(o.hw.cpuThreads)
  const run = async (file: string): Promise<void> => {
    const progress = separatorProgress(threads)
    await runTool(file, [relative(o.workDir, model), 'stem-in.wav', 'voice.wav', 'background.wav', String(threads)], {
      cwd: o.workDir,
      signal: o.signal,
      lowPriority: true,
      keepBytes: 16 * 1024,
      onStdout: (line) => {
        const f = progress(line)
        if (f !== null) o.onProgress(0.03 + 0.97 * f)
      }
    })
  }
  // Separation is CPU-heavy; do not run it alongside CPU transcription.
  const release = o.hw.whisper === 'cpu' ? await o.gpu.acquire(o.signal) : () => {}
  try {
    try {
      await run(exe)
    } catch (err) {
      const generic = join(exe, '..', 'crapcut-separate-sse2.exe')
      if (err instanceof ToolFailedError && err.code !== null && err.code >>> 0 === ILLEGAL_INSTRUCTION && existsSync(generic)) {
        log.warn('CPU lacks AVX2; using the generic separator build')
        await run(generic)
      } else throw err
    }
  } catch (err) {
    if (isCancelled(err)) throw err
    throw new UserError('Separating the voice failed for this clip. Try Original audio.', { cause: err })
  } finally {
    release()
  }

  const voice = join(o.workDir, 'voice.wav')
  const background = join(o.workDir, 'background.wav')
  if (!existsSync(voice) || !existsSync(background)) throw new UserError('Separating the voice failed for this clip. Try Original audio.')
  return { voice, background }
}
