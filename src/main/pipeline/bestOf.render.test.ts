// Runs the real best-of against tiny FFmpeg-generated sources and checks the
// result with ffprobe: the same steps the builder takes (each clip's sound to a
// WAV, one graph, one encode). Skips cleanly when FFmpeg is not on PATH -- CI
// and any machine without FFmpeg still pass `npm test`.

import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { captionStyle } from '@shared/captionStyles'
import type { Layout } from '@shared/types'
import { buildAss, defaultAssStyle } from '../core/ass'
import { buildBestOfRender, buildClipAudioArgs, DEFAULT_CROSSFADE_SEC, type BestOfClip } from '../core/bestOf'
import type { AudioPlan } from '../core/render'
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

const layout: Layout = { id: 'default-blur', name: 'Full frame', kind: 'blur_fill', cam: null, game: { x: 0, y: 0, w: 1, h: 1 } }

interface TestSource {
  seconds: number
  size: string
  rate: number
  freq: number
  sampleRate: number
  /** Leave out the sound track. */
  silent?: boolean
}

async function makeSource(file: string, o: TestSource): Promise<void> {
  const args = ['-hide_banner', '-y', '-f', 'lavfi', '-i', `testsrc2=size=${o.size}:rate=${o.rate}:duration=${o.seconds}`]
  if (!o.silent) args.push('-f', 'lavfi', '-i', `sine=frequency=${o.freq}:sample_rate=${o.sampleRate}:duration=${o.seconds}`, '-c:a', 'aac')
  await runTool(ffmpeg!, [...args, '-shortest', '-pix_fmt', 'yuv420p', '-preset', 'ultrafast', file])
}

/** What a kept clip needs from its source, like the builder's prep step. */
interface TestClip {
  file: string
  size: { width: number; height: number }
  seek: number
  duration: number
  /** Overrides the sound: original by default, or none for a source without any. */
  audio?: AudioPlan
  ass?: string
}

/** Prepares every clip like the builder (sound to a WAV, captions to a file), then runs the one encode. */
async function buildBestOf(dir: string, clips: TestClip[], out = 'out.mp4'): Promise<{ file: string; totalSec: number }> {
  const prepared: BestOfClip[] = []
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!
    const media = await probeMedia(ffprobe!, join(dir, c.file))
    const audio: AudioPlan = c.audio ?? (media.hasAudio ? { kind: 'original' } : { kind: 'silent' })
    const wav = `clip-${i}.wav`
    const audioArgs = buildClipAudioArgs({ input: join(dir, c.file), seek: c.seek, duration: c.duration, audio, loudness: null }, wav)
    if (audioArgs) await runTool(ffmpeg!, audioArgs, { cwd: dir })
    let assFile: string | null = null
    if (c.ass) {
      mkdirSync(join(dir, `clip-${i}-work`), { recursive: true })
      const words = Array.from({ length: Math.floor(c.duration) }, (_, w) => ({ t0: w, t1: w + 0.9, text: `${c.ass} ${w}` }))
      writeFileSync(join(dir, `clip-${i}-work`, 'captions.ass'), buildAss(words, defaultAssStyle('horizontal', 0.8, true, captionStyle('clean'))))
      assFile = `clip-${i}-work/captions.ass`
    }
    prepared.push({ input: c.file, seek: c.seek, duration: c.duration, source: c.size, layout, assFile, fontsDir: null, audioFile: audioArgs ? wav : null })
  }
  const r = buildBestOfRender(prepared, { crossfadeSec: DEFAULT_CROSSFADE_SEC, encoder: 'libx264', filterScript: 'graph.txt', output: out })
  writeFileSync(join(dir, 'graph.txt'), r.graph)
  await runTool(ffmpeg!, r.args, { cwd: dir })
  return { file: join(dir, out), totalSec: r.plan.totalDurationSec }
}

async function streams(file: string): Promise<{ type: string; rate: string; frames: string }[]> {
  const { stdout } = await runTool(ffprobe!, ['-v', 'error', '-count_frames', '-show_entries', 'stream=codec_type,r_frame_rate,sample_rate,nb_read_frames', '-of', 'json', file])
  const j = JSON.parse(stdout) as { streams: { codec_type: string; r_frame_rate: string; sample_rate?: string; nb_read_frames?: string }[] }
  return j.streams.map((s) => ({ type: s.codec_type, rate: s.codec_type === 'audio' ? (s.sample_rate ?? '') : s.r_frame_rate, frames: s.nb_read_frames ?? '' }))
}

/** md5 of one decoded frame, to tell two renders of the same picture apart. */
async function frameHash(file: string, at: number): Promise<string> {
  const { stdout } = await runTool(ffmpeg!, ['-hide_banner', '-v', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-f', 'md5', '-'])
  return stdout.trim()
}

/** Runs `fn` in a scratch folder that is removed afterwards. */
async function inScratch(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'crapcut-bestof-'))
  try {
    await fn(dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

const HD = { width: 1920, height: 1080 }

describe.skipIf(!ffmpeg || !ffprobe)('best-of in one encode (real FFmpeg)', () => {
  it('joins three clips of different size, frame rate and sample rate with crossfades', async () => {
    await inScratch(async (dir) => {
      // Like real sources of different formats and hardware would be.
      await makeSource(join(dir, 'a.mp4'), { seconds: 5, size: '1280x720', rate: 30, freq: 440, sampleRate: 44100 })
      await makeSource(join(dir, 'b.mp4'), { seconds: 5, size: '1920x1080', rate: 60, freq: 660, sampleRate: 48000 })
      await makeSource(join(dir, 'c.mp4'), { seconds: 3, size: '854x480', rate: 25, freq: 220, sampleRate: 32000 })

      const { file, totalSec } = await buildBestOf(dir, [
        { file: 'a.mp4', size: { width: 1280, height: 720 }, seek: 1, duration: 3 },
        { file: 'b.mp4', size: HD, seek: 0.5, duration: 2.5 },
        { file: 'c.mp4', size: { width: 854, height: 480 }, seek: 0, duration: 1 }
      ])

      const out = await probeMedia(ffprobe!, file)
      expect(out.width).toBe(1920)
      expect(out.height).toBe(1080)
      // The clips minus the crossfades actually used (the 1 s clip gets a shorter one).
      expect(totalSec).toBeCloseTo(3 + 2.5 + 1 - 0.5 - 0.4, 5)
      expect(out.duration).toBeGreaterThan(totalSec - 0.1)
      expect(out.duration).toBeLessThan(totalSec + 0.1)

      const s = await streams(file)
      expect(s.filter((x) => x.type === 'video')).toHaveLength(1)
      expect(s.filter((x) => x.type === 'audio')).toHaveLength(1)
      expect(s.find((x) => x.type === 'video')!.rate).toBe('30/1')
      expect(s.find((x) => x.type === 'audio')!.rate).toBe('48000')
      // 30 fps over the whole length, none dropped or doubled at the joins.
      expect(Number(s.find((x) => x.type === 'video')!.frames)).toBeCloseTo(totalSec * 30, -0.5)
    })
  }, 90_000)

  it('encodes a single clip with no crossfade', async () => {
    await inScratch(async (dir) => {
      await makeSource(join(dir, 'a.mp4'), { seconds: 4, size: '1920x1080', rate: 30, freq: 440, sampleRate: 48000 })
      const { file, totalSec } = await buildBestOf(dir, [{ file: 'a.mp4', size: HD, seek: 1, duration: 2 }])
      expect(totalSec).toBe(2)
      const out = await probeMedia(ffprobe!, file)
      expect(out.width).toBe(1920)
      expect(out.duration).toBeGreaterThan(1.9)
      expect(out.duration).toBeLessThan(2.1)
      expect(out.hasAudio).toBe(true)
    })
  }, 60_000)

  it('burns each clip its own captions', async () => {
    await inScratch(async (dir) => {
      await makeSource(join(dir, 'a.mp4'), { seconds: 4, size: '1920x1080', rate: 30, freq: 440, sampleRate: 48000 })
      await makeSource(join(dir, 'b.mp4'), { seconds: 4, size: '1920x1080', rate: 30, freq: 660, sampleRate: 48000 })
      const plain = [
        { file: 'a.mp4', size: HD, seek: 0, duration: 3 },
        { file: 'b.mp4', size: HD, seek: 0, duration: 3 }
      ]
      const bare = await buildBestOf(dir, plain, 'bare.mp4')
      const captioned = await buildBestOf(dir, [{ ...plain[0]!, ass: 'first' }, { ...plain[1]!, ass: 'second' }], 'captioned.mp4')

      const out = await probeMedia(ffprobe!, captioned.file)
      expect(out.duration).toBeGreaterThan(captioned.totalSec - 0.1)
      expect(out.duration).toBeLessThan(captioned.totalSec + 0.1)
      // A frame well inside each clip differs once its captions are on.
      expect(await frameHash(captioned.file, 1)).not.toBe(await frameHash(bare.file, 1))
      expect(await frameHash(captioned.file, 4)).not.toBe(await frameHash(bare.file, 4))
    })
  }, 90_000)

  it('keeps the timeline continuous when one clip has no sound', async () => {
    await inScratch(async (dir) => {
      await makeSource(join(dir, 'a.mp4'), { seconds: 3, size: '1920x1080', rate: 30, freq: 440, sampleRate: 48000 })
      await makeSource(join(dir, 'b.mp4'), { seconds: 3, size: '1920x1080', rate: 30, freq: 440, sampleRate: 48000, silent: true })
      await makeSource(join(dir, 'c.mp4'), { seconds: 3, size: '1920x1080', rate: 30, freq: 440, sampleRate: 48000 })
      const { file, totalSec } = await buildBestOf(dir, [
        { file: 'a.mp4', size: HD, seek: 0, duration: 2.5 },
        { file: 'b.mp4', size: HD, seek: 0, duration: 2.5 },
        { file: 'c.mp4', size: HD, seek: 0, duration: 2.5 }
      ])
      const s = await streams(file)
      expect(s.filter((x) => x.type === 'audio')).toHaveLength(1)
      const out = await probeMedia(ffprobe!, file)
      expect(out.duration).toBeGreaterThan(totalSec - 0.1)
      expect(out.duration).toBeLessThan(totalSec + 0.1)
    })
  }, 60_000)

  it('drops the sound track when no clip has any', async () => {
    await inScratch(async (dir) => {
      await makeSource(join(dir, 'a.mp4'), { seconds: 3, size: '1920x1080', rate: 30, freq: 440, sampleRate: 48000, silent: true })
      await makeSource(join(dir, 'b.mp4'), { seconds: 3, size: '1920x1080', rate: 30, freq: 440, sampleRate: 48000, silent: true })
      const { file, totalSec } = await buildBestOf(dir, [
        { file: 'a.mp4', size: HD, seek: 0, duration: 2 },
        { file: 'b.mp4', size: HD, seek: 0, duration: 2 }
      ])
      const out = await probeMedia(ffprobe!, file)
      expect(out.hasAudio).toBe(false)
      expect(out.duration).toBeGreaterThan(totalSec - 0.1)
      expect(out.duration).toBeLessThan(totalSec + 0.1)
    })
  }, 60_000)

  it('mixes a voice stem with a quieter game stem for one clip', async () => {
    await inScratch(async (dir) => {
      await makeSource(join(dir, 'a.mp4'), { seconds: 4, size: '1920x1080', rate: 30, freq: 440, sampleRate: 48000 })
      await makeSource(join(dir, 'b.mp4'), { seconds: 4, size: '1920x1080', rate: 30, freq: 660, sampleRate: 48000 })
      // Stand-ins for separated stems: clip-length WAVs starting at the clip start.
      for (const [name, freq] of [['voice.wav', 300], ['game.wav', 900]] as const) {
        await runTool(ffmpeg!, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=44100:duration=3`, '-ac', '2', join(dir, name)])
      }
      const stems: AudioPlan = { kind: 'stems', voice: join(dir, 'voice.wav'), game: join(dir, 'game.wav'), gameGain: 0.3, music: null, musicGain: 0 }
      const { file, totalSec } = await buildBestOf(dir, [
        { file: 'a.mp4', size: HD, seek: 0.5, duration: 3, audio: stems },
        { file: 'b.mp4', size: HD, seek: 0, duration: 3 }
      ])
      const s = await streams(file)
      expect(s.filter((x) => x.type === 'audio')).toHaveLength(1)
      const out = await probeMedia(ffprobe!, file)
      expect(out.duration).toBeGreaterThan(totalSec - 0.1)
      expect(out.duration).toBeLessThan(totalSec + 0.1)
    })
  }, 90_000)

  it('still lines up when a source ends before the clip should', async () => {
    await inScratch(async (dir) => {
      // The source is 3 s but the clip asks for 4 s (a section download that came up short).
      await makeSource(join(dir, 'a.mp4'), { seconds: 3, size: '1920x1080', rate: 30, freq: 440, sampleRate: 48000 })
      await makeSource(join(dir, 'b.mp4'), { seconds: 4, size: '1920x1080', rate: 30, freq: 660, sampleRate: 48000 })
      const { file, totalSec } = await buildBestOf(dir, [
        { file: 'a.mp4', size: HD, seek: 0, duration: 4 },
        { file: 'b.mp4', size: HD, seek: 0, duration: 4 }
      ])
      const out = await probeMedia(ffprobe!, file)
      expect(totalSec).toBeCloseTo(7.5, 5)
      expect(out.duration).toBeGreaterThan(totalSec - 0.1)
      expect(out.duration).toBeLessThan(totalSec + 0.1)
    })
  }, 90_000)
})
