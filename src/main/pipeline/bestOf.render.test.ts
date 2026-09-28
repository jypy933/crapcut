// Runs the real join against tiny FFmpeg-generated inputs and checks the
// result with ffprobe. Skips cleanly when FFmpeg is not on PATH -- CI and any
// machine without FFmpeg still pass `npm test`.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildBestOfArgs, planBestOfJoin, type BestOfClipInput } from '../core/bestOf'
import { runTool } from '../tools/process'
import { probeMedia } from './media'

function findOnPath(name: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' })
    const first = out.split(/\r?\n/).find((l) => l.trim())
    return first?.trim() || null
  } catch {
    return null
  }
}

const ffmpeg = findOnPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const ffprobe = findOnPath(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')

async function makeTestClip(file: string, opts: { seconds: number; size: string; rate: number; freq: number; sampleRate: number }): Promise<void> {
  await runTool(ffmpeg!, [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${opts.size}:rate=${opts.rate}:duration=${opts.seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=${opts.freq}:sample_rate=${opts.sampleRate}:duration=${opts.seconds}`,
    '-shortest',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    file
  ])
}

async function streamKinds(file: string): Promise<string[]> {
  const { stdout } = await runTool(ffprobe!, ['-v', 'error', '-show_entries', 'stream=codec_type', '-of', 'csv=p=0', file])
  return stdout
    .trim()
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
}

describe.skipIf(!ffmpeg || !ffprobe)('best-of join (real FFmpeg)', () => {
  it('normalises differing fps/resolution/sample rate and joins with crossfades', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-bestof-'))
    try {
      // Three clips with different sizes, frame rates and audio sample rates,
      // like real exports of different formats/hardware would produce.
      await makeTestClip(join(dir, 'a.mp4'), { seconds: 3, size: '1280x720', rate: 30, freq: 440, sampleRate: 44100 })
      await makeTestClip(join(dir, 'b.mp4'), { seconds: 2.5, size: '1920x1080', rate: 60, freq: 660, sampleRate: 48000 })
      await makeTestClip(join(dir, 'c.mp4'), { seconds: 1, size: '854x480', rate: 25, freq: 220, sampleRate: 32000 })

      const files = ['a.mp4', 'b.mp4', 'c.mp4']
      const inputs: BestOfClipInput[] = []
      for (const f of files) {
        const media = await probeMedia(ffprobe!, join(dir, f))
        inputs.push({ file: f, duration: media.duration, hasAudio: media.hasAudio })
      }

      const plan = planBestOfJoin(inputs, 0.5)
      const args = buildBestOfArgs(inputs, { crossfadeSec: 0.5, encoder: 'libx264', output: 'out.mp4' })
      await runTool(ffmpeg!, args, { cwd: dir })

      const out = await probeMedia(ffprobe!, join(dir, 'out.mp4'))
      expect(out.width).toBe(1920)
      expect(out.height).toBe(1080)
      // xfade/acrossfade overlap the joins, so the result is roughly the sum
      // of the clips minus the crossfades actually used.
      expect(out.duration).toBeGreaterThan(plan.totalDurationSec - 0.3)
      expect(out.duration).toBeLessThan(plan.totalDurationSec + 0.3)

      const kinds = await streamKinds(join(dir, 'out.mp4'))
      expect(kinds.filter((k) => k === 'video')).toHaveLength(1)
      expect(kinds.filter((k) => k === 'audio')).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('re-encodes a single clip with no crossfade', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-bestof-one-'))
    try {
      await makeTestClip(join(dir, 'a.mp4'), { seconds: 2, size: '1920x1080', rate: 30, freq: 440, sampleRate: 48000 })
      const media = await probeMedia(ffprobe!, join(dir, 'a.mp4'))
      const inputs: BestOfClipInput[] = [{ file: 'a.mp4', duration: media.duration, hasAudio: media.hasAudio }]
      const args = buildBestOfArgs(inputs, { crossfadeSec: 0.5, encoder: 'libx264', output: 'out.mp4' })
      await runTool(ffmpeg!, args, { cwd: dir })

      const out = await probeMedia(ffprobe!, join(dir, 'out.mp4'))
      expect(out.width).toBe(1920)
      expect(out.height).toBe(1080)
      expect(out.duration).toBeGreaterThan(media.duration - 0.3)
      expect(out.duration).toBeLessThan(media.duration + 0.3)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('keeps the timeline continuous when one clip has no audio', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-bestof-silent-'))
    try {
      await makeTestClip(join(dir, 'a.mp4'), { seconds: 2, size: '1920x1080', rate: 30, freq: 440, sampleRate: 48000 })
      await runTool(ffmpeg!, ['-hide_banner', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=1920x1080:rate=30:duration=2', '-pix_fmt', 'yuv420p', '-an', join(dir, 'b.mp4')])

      const files = ['a.mp4', 'b.mp4']
      const inputs: BestOfClipInput[] = []
      for (const f of files) {
        const media = await probeMedia(ffprobe!, join(dir, f))
        inputs.push({ file: f, duration: media.duration, hasAudio: media.hasAudio })
      }
      expect(inputs[1]!.hasAudio).toBe(false)

      const args = buildBestOfArgs(inputs, { crossfadeSec: 0.5, encoder: 'libx264', output: 'out.mp4' })
      await runTool(ffmpeg!, args, { cwd: dir })

      const out = await probeMedia(ffprobe!, join(dir, 'out.mp4'))
      expect(out.hasAudio).toBe(true)
      const kinds = await streamKinds(join(dir, 'out.mp4'))
      expect(kinds.filter((k) => k === 'audio')).toHaveLength(1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
