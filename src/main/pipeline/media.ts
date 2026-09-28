// FFmpeg helpers used by the pipeline: audio preparation, probing, PCM
// extraction, and the muted-segment playlist fetch.

import { spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Range } from '@shared/types'
import { parseMutedSegments } from '../core/media'
import { parseProgressSeconds } from '../core/render'
import { killTree, runTool } from '../tools/process'
import { CancelledError, UserError } from '../util/errors'

/**
 * One pass over the downloaded audio: a 16 kHz mono WAV for whisper and a
 * per-second loudness log. Both are written relative to `cwd`.
 */
export async function prepareAudio(
  ffmpeg: string,
  cwd: string,
  input: string,
  wavName: string,
  loudName: string,
  durationSec: number,
  signal: AbortSignal,
  onProgress: (f: number) => void
): Promise<void> {
  const graph =
    '[0:a]asplit=2[a][b];' +
    `[b]aresample=8000,asetnsamples=n=8000:p=0,astats=metadata=1:reset=1:measure_perchannel=none:measure_overall=RMS_level,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level:file=${loudName}[m]`
  await runTool(
    ffmpeg,
    [
      '-hide_banner',
      '-nostdin',
      '-y',
      '-progress',
      'pipe:1',
      '-nostats',
      '-i',
      input,
      '-filter_complex',
      graph,
      '-map',
      '[a]',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'pcm_s16le',
      wavName,
      '-map',
      '[m]',
      '-f',
      'null',
      '-'
    ],
    {
      cwd,
      signal,
      lowPriority: true,
      onStdout: (line) => {
        const s = parseProgressSeconds(line)
        if (s !== null) onProgress(Math.min(1, s / Math.max(1, durationSec)))
      }
    }
  )
}

export interface MediaInfo {
  duration: number
  width: number
  height: number
  fps: number
  hasAudio: boolean
}

export async function probeMedia(ffprobe: string, file: string, signal?: AbortSignal): Promise<MediaInfo> {
  const { stdout } = await runTool(ffprobe, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { signal, timeoutMs: 60_000 })
  const j = JSON.parse(stdout) as {
    format?: { duration?: string }
    streams?: { codec_type?: string; width?: number; height?: number; avg_frame_rate?: string; r_frame_rate?: string }[]
  }
  const v = j.streams?.find((s) => s.codec_type === 'video')
  const rate = (s?: string): number => {
    const [n, d] = (s ?? '0/1').split('/').map(Number)
    return d ? n! / d : 0
  }
  return {
    duration: Number(j.format?.duration ?? 0),
    width: v?.width ?? 0,
    height: v?.height ?? 0,
    fps: rate(v?.avg_frame_rate) || rate(v?.r_frame_rate) || 30,
    hasAudio: !!j.streams?.some((s) => s.codec_type === 'audio')
  }
}

/** Copies [start, start+duration] of a PCM WAV into its own file (exact for PCM). Paths are relative to `cwd`. */
export async function cutWav(ffmpeg: string, cwd: string, input: string, start: number, duration: number, output: string, signal: AbortSignal): Promise<void> {
  await runTool(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-ss', start.toFixed(3), '-t', duration.toFixed(3), '-i', input, '-c', 'copy', output], { cwd, signal })
}

/** Mono 8 kHz float PCM of [start, start+duration] of a file. */
export async function extractPcm(ffmpeg: string, file: string, start: number, duration: number, signal?: AbortSignal): Promise<Buffer> {
  const { stdout } = await runToolBinary(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-ss', start.toFixed(3), '-t', duration.toFixed(3), '-i', file, '-vn', '-ac', '1', '-ar', '8000', '-f', 's16le', '-'], signal)
  return stdout
}

function runToolBinary(file: string, args: string[], signal?: AbortSignal): Promise<{ stdout: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    const chunks: Buffer[] = []
    let err = ''
    child.stdout.on('data', (d: Buffer) => chunks.push(d))
    child.stderr.on('data', (d: Buffer) => (err = (err + d.toString()).slice(-4000)))
    const onAbort = (): void => {
      if (child.pid) killTree(child.pid)
    }
    signal?.addEventListener('abort', onAbort, { once: true })
    child.on('error', reject)
    child.on('close', (code) => {
      signal?.removeEventListener('abort', onAbort)
      if (signal?.aborted) return reject(new CancelledError())
      if (code !== 0) return reject(new Error(`ffmpeg pcm failed: ${err}`))
      resolve({ stdout: Buffer.concat(chunks) })
    })
  })
}

const PLAYLIST_HOSTS = /(^|\.)(cloudfront\.net|ttvnw\.net|twitch\.tv|jtvnw\.net|live-video\.net)$/i

/** Downloads the audio playlist (a small text file) and returns the muted ranges. */
export async function fetchMutedRanges(playlistUrl: string, signal: AbortSignal): Promise<Range[]> {
  const u = new URL(playlistUrl)
  if (u.protocol !== 'https:' || !PLAYLIST_HOSTS.test(u.hostname)) throw new Error(`unexpected playlist host ${u.hostname}`)
  const res = await fetch(u, { signal, redirect: 'error' })
  if (!res.ok) throw new Error(`playlist HTTP ${res.status}`)
  const text = await res.text()
  if (text.length > 20 * 1024 * 1024) throw new Error('playlist too large')
  return parseMutedSegments(text)
}

/** Finds long stretches of digital silence (Twitch's muting) in the loudness log. */
export function silentRanges(loudness: Float64Array, minSec = 8): Range[] {
  const out: Range[] = []
  let start = -1
  for (let i = 0; i <= loudness.length; i++) {
    const silent = i < loudness.length && loudness[i]! <= -90
    if (silent && start < 0) start = i
    if (!silent && start >= 0) {
      if (i - start >= minSec) out.push({ start, end: i })
      start = -1
    }
  }
  return out
}

export async function readText(dir: string, name: string): Promise<string> {
  try {
    return await readFile(join(dir, name), 'utf8')
  } catch {
    throw new UserError('A work file is missing. Retry to rebuild it.', { detail: `${name} missing` })
  }
}
