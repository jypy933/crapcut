// Runs the real caption + chat-overlay burn-in against a tiny FFmpeg-generated
// input and checks the result with ffprobe. Skips cleanly when FFmpeg is not
// on PATH -- CI and any machine without FFmpeg still pass `npm test`.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { buildChatOverlay, chatOverlayGeometry } from '@shared/chatOverlay'
import { OUTPUT_SIZE } from '@shared/layoutGeometry'
import type { ChatMessage, Layout, Word } from '@shared/types'
import { buildRenderArgs, type RenderSpec } from './render'
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

async function makeTestClip(file: string, seconds: number): Promise<void> {
  await runTool(ffmpeg!, [
    '-hide_banner',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1280x720:rate=30:duration=${seconds}`,
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

const words: Word[] = [
  { t0: 0.2, t1: 0.5, text: 'okay' },
  { t0: 0.5, t1: 0.9, text: 'watch' },
  { t0: 0.9, t1: 1.3, text: 'this' },
  { t0: 1.3, t1: 1.8, text: 'clutch' }
]

const chatMessages: ChatMessage[] = [
  { t: 0, user: 'zap', text: 'no way' },
  { t: 1, user: 'kayleigh_', text: 'KEKW he actually did it' },
  { t: 1, user: 'PixelPunk', text: 'insane' },
  { t: 2, user: 'streamfan99', text: 'this is the clip right here, save it before it gets taken down' },
  { t: 3, user: '山田', text: 'w' } // CJK name, mixed with the bundled font's Latin-only coverage
]

const camGameLayout: Layout = { id: 'l1', name: 'Cam', kind: 'cam_game', cam: { x: 0.72, y: 0.02, w: 0.26, h: 0.3 }, game: { x: 0, y: 0, w: 1, h: 1 } }
const blurFillLayout: Layout = { id: 'l2', name: 'Full frame', kind: 'blur_fill', cam: null, game: { x: 0, y: 0, w: 1, h: 1 } }

describe.skipIf(!ffmpeg || !ffprobe)('caption + chat overlay burn-in (real FFmpeg)', () => {
  it('renders a vertical clip with captions and a chat overlay avoiding the facecam', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-chatoverlay-'))
    try {
      const seconds = 4
      await makeTestClip(join(dir, 'in.mp4'), seconds)
      const media = await probeMedia(ffprobe!, join(dir, 'in.mp4'))

      const geometry = chatOverlayGeometry('vertical', camGameLayout, { width: media.width, height: media.height }, 0.72)
      const chatLines = buildChatOverlay(chatMessages, 0, seconds, geometry)
      expect(chatLines.length).toBeGreaterThan(0)

      const ass = buildAss(words, defaultAssStyle('vertical', 0.72, true), { lines: chatLines, font: { fontName: 'Segoe UI', fontSize: 34 } })
      expect(ass).toContain('Style: Chat,')
      writeFileSync(join(dir, 'captions.ass'), ass)

      const spec: RenderSpec = {
        input: 'in.mp4',
        seek: 0,
        duration: seconds,
        source: { width: media.width, height: media.height },
        sourceFps: media.fps,
        format: 'vertical',
        layout: camGameLayout,
        assFile: 'captions.ass',
        fontsDir: null,
        audio: { kind: 'original' },
        loudness: null,
        encoder: 'libx264',
        output: 'out.mp4'
      }
      await runTool(ffmpeg!, buildRenderArgs(spec), { cwd: dir })

      const out = await probeMedia(ffprobe!, join(dir, 'out.mp4'))
      expect(out.width).toBe(OUTPUT_SIZE.vertical.width)
      expect(out.height).toBe(OUTPUT_SIZE.vertical.height)
      expect(out.hasAudio).toBe(true)
      expect(out.duration).toBeGreaterThan(seconds - 0.5)
      expect(out.duration).toBeLessThan(seconds + 0.5)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it('renders a horizontal clip with captions and a chat overlay', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-chatoverlay-h-'))
    try {
      const seconds = 3
      await makeTestClip(join(dir, 'in.mp4'), seconds)
      const media = await probeMedia(ffprobe!, join(dir, 'in.mp4'))

      const captionY = Math.max(0.6, Math.min(0.92, 0.72 + 0.1))
      const geometry = chatOverlayGeometry('horizontal', blurFillLayout, { width: media.width, height: media.height }, captionY)
      const chatLines = buildChatOverlay(chatMessages, 0, seconds, geometry)
      expect(chatLines.length).toBeGreaterThan(0)

      const ass = buildAss(words, defaultAssStyle('horizontal', captionY, true), { lines: chatLines, font: { fontName: 'Segoe UI', fontSize: 34 } })
      writeFileSync(join(dir, 'captions.ass'), ass)

      const spec: RenderSpec = {
        input: 'in.mp4',
        seek: 0,
        duration: seconds,
        source: { width: media.width, height: media.height },
        sourceFps: media.fps,
        format: 'horizontal',
        layout: blurFillLayout,
        assFile: 'captions.ass',
        fontsDir: null,
        audio: { kind: 'original' },
        loudness: null,
        encoder: 'libx264',
        output: 'out.mp4'
      }
      await runTool(ffmpeg!, buildRenderArgs(spec), { cwd: dir })

      const out = await probeMedia(ffprobe!, join(dir, 'out.mp4'))
      expect(out.width).toBe(OUTPUT_SIZE.horizontal.width)
      expect(out.height).toBe(OUTPUT_SIZE.horizontal.height)
      expect(out.hasAudio).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
