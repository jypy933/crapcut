// Runs the real EDL re-edit graph against a tiny FFmpeg-generated input and
// checks the result with ffprobe. Skips cleanly when FFmpeg is not on PATH --
// CI and any machine without FFmpeg still pass `npm test`.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Layout, Word } from '@shared/types'
import type { Edl, EdlSegment } from './edl'
import { outputDuration } from './edl'
import { remapWordsToEdl } from './edlCaptions'
import { buildEdlRenderArgs, buildOverlayAss, edlToFilterGraph, type EdlRenderSpec } from './edlFilter'
import { buildAss, defaultAssStyle } from './ass'
import { probeMedia } from '../pipeline/media'
import { runTool } from '../tools/process'

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

const SOURCE_FPS = 60
const SOURCE_SIZE = '1920x1080'

async function makeSourceClip(file: string, seconds: number): Promise<void> {
  await runTool(ffmpeg!, [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${SOURCE_SIZE}:rate=${SOURCE_FPS}:duration=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    '-shortest',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    file
  ])
}

async function makeSfxClip(file: string, seconds: number, freq: number): Promise<void> {
  await runTool(ffmpeg!, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `sine=frequency=${freq}:sample_rate=48000:duration=${seconds}`, file])
}

/** Structural similarity (0-1) of two images, via FFmpeg's `ssim` filter. */
async function ssim(a: string, b: string): Promise<number> {
  const { stderr } = await runTool(ffmpeg!, ['-hide_banner', '-i', a, '-i', b, '-lavfi', 'ssim', '-f', 'null', '-'])
  const m = /All:([\d.]+)/.exec(stderr)
  if (!m) throw new Error('no ssim result')
  return Number(m[1])
}

/** One frame of `file` at `t` seconds, optionally run through `vf`, saved as a PNG. */
async function frameAt(file: string, t: number, out: string, vf?: string): Promise<void> {
  await runTool(ffmpeg!, ['-hide_banner', '-y', '-ss', String(t), '-i', file, ...(vf ? ['-vf', vf] : []), '-frames:v', '1', out])
}

const seg = (srcStart: number, srcEnd: number, speed = 1): EdlSegment => ({ srcStart, srcEnd, speed })

const baseEdl = (over: Partial<Edl> = {}): Edl => ({
  segments: [seg(0, 3)],
  zoom: [],
  freeze: [],
  overlays: [],
  sfx: [],
  ending: { kind: 'cut' },
  ...over
})

const layout: Layout = { id: 'l', name: 'Full', kind: 'center_crop', cam: null, game: { x: 0, y: 0, w: 1, h: 1 } }

async function runEdl(dir: string, edl: Edl, over: Partial<EdlRenderSpec> = {}): Promise<{ width: number; height: number; duration: number; hasAudio: boolean; audioDuration: number | null }> {
  const spec: EdlRenderSpec = {
    input: 'in.mp4',
    source: { width: 1920, height: 1080 },
    sourceFps: SOURCE_FPS,
    format: 'horizontal',
    layout,
    edl,
    captionsAssFile: null,
    overlayAssFile: null,
    fontsDir: null,
    audio: { kind: 'original' },
    loudness: null,
    encoder: 'libx264',
    filterScript: 'graph.txt',
    output: 'out.mp4',
    ...over
  }
  const { graph } = edlToFilterGraph(spec)
  writeFileSync(join(dir, spec.filterScript), graph)
  await runTool(ffmpeg!, buildEdlRenderArgs(spec), { cwd: dir })

  const out = await probeMedia(ffprobe!, join(dir, spec.output))
  let audioDuration: number | null = null
  if (out.hasAudio) {
    const { stdout } = await runTool(ffprobe!, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', join(dir, spec.output)])
    audioDuration = Number(stdout.trim())
  }
  return { width: out.width, height: out.height, duration: out.duration, hasAudio: out.hasAudio, audioDuration }
}

describe.skipIf(!ffmpeg || !ffprobe)('EDL re-edit graph (real FFmpeg)', () => {
  it('reorders a cold open before the full moment', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-edl-reorder-'))
    try {
      await makeSourceClip(join(dir, 'in.mp4'), 6)
      const edl = baseEdl({ segments: [seg(4, 5), seg(0, 6)] })
      const out = await runEdl(dir, edl)
      const frame = 1 / SOURCE_FPS
      expect(out.width).toBe(1920)
      expect(out.height).toBe(1080)
      expect(out.duration).toBeGreaterThan(outputDuration(edl) - frame)
      expect(out.duration).toBeLessThan(outputDuration(edl) + frame)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('cuts several short segments together (jump cuts)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-edl-jumpcuts-'))
    try {
      await makeSourceClip(join(dir, 'in.mp4'), 8)
      const edl = baseEdl({ segments: [seg(0, 1), seg(2, 2.5), seg(5, 6.2)] })
      const out = await runEdl(dir, edl)
      const frame = 1 / SOURCE_FPS
      expect(out.duration).toBeGreaterThan(outputDuration(edl) - frame)
      expect(out.duration).toBeLessThan(outputDuration(edl) + frame)
      expect(out.hasAudio).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('renders a punch-in zoom with shake', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-edl-zoom-'))
    try {
      await makeSourceClip(join(dir, 'in.mp4'), 4)
      const edl = baseEdl({ segments: [seg(0, 4)], zoom: [{ t: 0, scale: 1, ease: 'snap' }, { t: 1, scale: 1.6, ease: 'snap', shakeAmp: 8 }] })
      const out = await runEdl(dir, edl)
      const frame = 1 / SOURCE_FPS
      expect(out.width).toBe(1920)
      expect(out.height).toBe(1080)
      expect(out.duration).toBeGreaterThan(outputDuration(edl) - frame)
      expect(out.duration).toBeLessThan(outputDuration(edl) + frame)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('zooms in only from the keyframe on (the crop is not fixed from frame 0)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-edl-zoomcurve-'))
    try {
      await makeSourceClip(join(dir, 'in.mp4'), 4)
      const edl = baseEdl({ segments: [seg(0, 4)], zoom: [{ t: 0, scale: 1, ease: 'snap' }, { t: 1, scale: 2, ease: 'snap' }] })
      await runEdl(dir, edl)

      // Before the keyframe the picture is the plain source; after it, the
      // centre half of the source blown up to fill the frame.
      await frameAt(join(dir, 'out.mp4'), 0.5, join(dir, 'out-before.png'))
      await frameAt(join(dir, 'out.mp4'), 2.5, join(dir, 'out-after.png'))
      await frameAt(join(dir, 'in.mp4'), 0.5, join(dir, 'ref-before.png'))
      await frameAt(join(dir, 'in.mp4'), 2.5, join(dir, 'ref-plain.png'))
      await frameAt(join(dir, 'in.mp4'), 2.5, join(dir, 'ref-zoomed.png'), 'crop=960:540:480:270,scale=1920:1080:flags=lanczos')

      expect(await ssim(join(dir, 'out-before.png'), join(dir, 'ref-before.png'))).toBeGreaterThan(0.9)
      expect(await ssim(join(dir, 'out-after.png'), join(dir, 'ref-zoomed.png'))).toBeGreaterThan(0.9)
      expect(await ssim(join(dir, 'out-after.png'), join(dir, 'ref-plain.png'))).toBeLessThan(0.7)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('holds a freeze frame with matching silence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-edl-freeze-'))
    try {
      await makeSourceClip(join(dir, 'in.mp4'), 5)
      const edl = baseEdl({ segments: [seg(0, 5)], freeze: [{ atOutputT: 2, holdSec: 1 }] })
      const out = await runEdl(dir, edl)
      const frame = 1 / SOURCE_FPS
      expect(out.duration).toBeGreaterThan(outputDuration(edl) - frame)
      expect(out.duration).toBeLessThan(outputDuration(edl) + frame)
      expect(out.hasAudio).toBe(true)
      // A/V sync: both tracks land within 50ms of the same total length.
      expect(out.audioDuration).not.toBeNull()
      expect(Math.abs(out.audioDuration! - out.duration)).toBeLessThan(0.05)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('plays a segment at a different speed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-edl-speed-'))
    try {
      await makeSourceClip(join(dir, 'in.mp4'), 6)
      const edl = baseEdl({ segments: [seg(0, 2), seg(2, 6, 2)] })
      const out = await runEdl(dir, edl)
      const frame = 1 / SOURCE_FPS
      // 2s normal + (4s source / 2x speed = 2s) = 4s total.
      expect(outputDuration(edl)).toBeCloseTo(4, 5)
      expect(out.duration).toBeGreaterThan(outputDuration(edl) - frame)
      expect(out.duration).toBeLessThan(outputDuration(edl) + frame)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('mixes in an sfx cue', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-edl-sfx-'))
    try {
      await makeSourceClip(join(dir, 'in.mp4'), 4)
      await makeSfxClip(join(dir, 'boing.wav'), 0.4, 880)
      const edl = baseEdl({ segments: [seg(0, 4)], sfx: [{ t: 1, file: 'boing.wav', gainDb: -3 }] })
      const out = await runEdl(dir, edl)
      const frame = 1 / SOURCE_FPS
      expect(out.hasAudio).toBe(true)
      expect(out.duration).toBeGreaterThan(outputDuration(edl) - frame)
      expect(out.duration).toBeLessThan(outputDuration(edl) + frame)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)

  it('renders a combined edit: reorder, zoom, freeze, speed, captions and an overlay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-edl-combined-'))
    try {
      await makeSourceClip(join(dir, 'in.mp4'), 10)
      const edl: Edl = {
        segments: [seg(6, 7), seg(0, 4), seg(4, 10, 1.5)],
        zoom: [{ t: 0, scale: 1, ease: 'snap' }, { t: 0.5, scale: 1.4, ease: 'smooth', shakeAmp: 4 }],
        freeze: [{ atOutputT: 1, holdSec: 0.5 }],
        overlays: [{ kind: 'quoteBar', t0: 0, t1: 0.8, text: 'no way he clutched it', pos: { x: 0.5, y: 0.15, align: 'center' } }],
        sfx: [{ t: 2, file: 'boing.wav', gainDb: -6 }],
        ending: { kind: 'cut' }
      }
      await makeSfxClip(join(dir, 'boing.wav'), 0.3, 660)

      const words: Word[] = [
        { t0: 6.1, t1: 6.4, text: 'watch' },
        { t0: 6.4, t1: 6.9, text: 'this' },
        { t0: 0.2, t1: 0.6, text: 'okay' },
        { t0: 5.0, t1: 5.4, text: 'clutch' }
      ]
      const remapped = remapWordsToEdl(words, edl)
      expect(remapped.length).toBeGreaterThan(0)
      const captionsAss = buildAss(remapped, defaultAssStyle('horizontal', 0.85, true))
      writeFileSync(join(dir, 'captions.ass'), captionsAss)

      const overlayAss = buildOverlayAss(edl.overlays, { width: 1920, height: 1080, fontName: 'Segoe UI', fontSize: 48 })
      writeFileSync(join(dir, 'overlay.ass'), overlayAss)

      const out = await runEdl(dir, edl, { captionsAssFile: 'captions.ass', overlayAssFile: 'overlay.ass' })
      const frame = 1 / SOURCE_FPS
      expect(out.width).toBe(1920)
      expect(out.height).toBe(1080)
      expect(out.duration).toBeGreaterThan(outputDuration(edl) - frame)
      expect(out.duration).toBeLessThan(outputDuration(edl) + frame)
      expect(out.hasAudio).toBe(true)
      expect(out.audioDuration).not.toBeNull()
      expect(Math.abs(out.audioDuration! - out.duration)).toBeLessThan(0.05)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 180_000)
})
