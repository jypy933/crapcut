// Helpers for render tests: find FFmpeg, make tiny media on the fly, probe output.

import { execFile, spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'

const run = promisify(execFile)

export const FFMPEG = process.env.CRAPCUT_FFMPEG ?? 'ffmpeg'
export const FFPROBE = process.env.CRAPCUT_FFPROBE ?? 'ffprobe'

export const hasFfmpeg = (() => {
  const r = spawnSync(FFMPEG, ['-version'], { encoding: 'utf8' })
  return r.status === 0
})()

/** A temp folder whose name has a space, an apostrophe and non-ASCII letters. */
export function awkwardTempDir(): { dir: string; cleanup: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'crapcut-'))
  const dir = join(base, "Zoë O'Brien clips")
  mkdirSync(dir, { recursive: true })
  return { dir, cleanup: () => rmSync(base, { recursive: true, force: true }) }
}

export async function ffmpeg(args: string[], cwd?: string): Promise<{ stdout: string; stderr: string }> {
  return run(FFMPEG, ['-hide_banner', '-nostdin', '-y', ...args], { cwd, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
}

export async function makeTestVideo(file: string, seconds: number, size = '1920x1080', fps = 60): Promise<void> {
  await ffmpeg([
    '-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=${fps}:duration=${seconds}`,
    '-f', 'lavfi', '-i', `sine=frequency=440:duration=${seconds}:sample_rate=48000`,
    '-c:v', 'libx264', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-shortest', file
  ])
}

export async function makeTone(file: string, seconds: number, freq: number): Promise<void> {
  await ffmpeg(['-f', 'lavfi', '-i', `sine=frequency=${freq}:duration=${seconds}:sample_rate=48000`, '-ac', '2', file])
}

export interface Probe {
  duration: number
  video: { width: number; height: number; fps: number; codec: string } | null
  audio: { codec: string; sampleRate: number; channels: number } | null
}

export async function probe(file: string): Promise<Probe> {
  const { stdout } = await run(FFPROBE, ['-v', 'error', '-show_format', '-show_streams', '-of', 'json', file], { windowsHide: true })
  const j = JSON.parse(stdout) as {
    format: { duration: string }
    streams: { codec_type: string; codec_name: string; width?: number; height?: number; avg_frame_rate?: string; sample_rate?: string; channels?: number }[]
  }
  const v = j.streams.find((s) => s.codec_type === 'video')
  const a = j.streams.find((s) => s.codec_type === 'audio')
  const [num, den] = (v?.avg_frame_rate ?? '0/1').split('/').map(Number)
  return {
    duration: Number(j.format.duration),
    video: v ? { width: v.width!, height: v.height!, fps: den ? num! / den : 0, codec: v.codec_name } : null,
    audio: a ? { codec: a.codec_name, sampleRate: Number(a.sample_rate), channels: a.channels! } : null
  }
}
