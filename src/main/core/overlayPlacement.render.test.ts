// Burns a caption and a chat box into a black frame with the real export
// arguments and finds the bright text again, proving that an overlay the
// streamer dragged lands where the shared placement maths (the same numbers
// the review preview draws with) says it does. Skips cleanly when FFmpeg is
// not on PATH.

import { execFileSync } from 'node:child_process'
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { captionY } from '@shared/captionPlacement'
import { buildChatOverlay, chatOverlayGeometry, DEFAULT_CHAT_OVERLAY_OPTIONS } from '@shared/chatOverlay'
import { OUTPUT_SIZE, type RenderFormat } from '@shared/layoutGeometry'
import type { ChatMessage, Layout, Word } from '@shared/types'
import { buildRenderArgs, type RenderSpec } from './render'
import { buildAss, defaultAssStyle } from './ass'
import { runTool } from '../tools/process'

function findOnPath(name: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' })
    return out.split(/\r?\n/).find((l) => l.trim())?.trim() || null
  } catch {
    return null
  }
}

const ffmpeg = findOnPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const ffprobe = findOnPath(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
const source = { width: 1280, height: 720 }
const layout: Layout = { id: 'l', name: 'Full frame', kind: 'blur_fill', cam: null, game: { x: 0, y: 0, w: 1, h: 1 } }
const font = join(process.cwd(), 'resources', 'fonts', 'Montserrat-Black.ttf')

// One long word so the caption is on screen for the whole test frame.
const words: Word[] = [{ t0: 0, t1: 4, text: 'HHHH' }]
const chat: ChatMessage[] = [
  { t: 0, user: 'zap', text: 'WWWWWWWW WWWWWWWW' },
  { t: 0, user: 'kay', text: 'WWWWWWWW WWWWWWWW' }
]

interface Bright {
  top: number
  bottom: number
  left: number
  right: number
  centreY: number
}

/** Renders `ass` over black in `format` and returns the bounding box of the bright pixels in the rows/columns given. */
async function renderBright(dir: string, format: RenderFormat, ass: string, region: { x0: number; x1: number; y0: number; y1: number }): Promise<Bright> {
  writeFileSync(join(dir, 'captions.ass'), ass)
  const spec: RenderSpec = {
    input: 'in.mp4',
    seek: 0,
    duration: 3,
    source,
    sourceFps: 30,
    format,
    layout,
    assFile: 'captions.ass',
    fontsDir: 'fonts',
    audio: { kind: 'silent' },
    loudness: null,
    encoder: 'libx264',
    output: 'out.mp4'
  }
  await runTool(ffmpeg!, buildRenderArgs(spec), { cwd: dir })
  await runTool(ffmpeg!, ['-hide_banner', '-y', '-ss', '1.5', '-i', 'out.mp4', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'frame.rgb'], { cwd: dir })
  const rgb = readFileSync(join(dir, 'frame.rgb'))
  const { width } = OUTPUT_SIZE[format]
  let top = Infinity
  let bottom = -1
  let left = Infinity
  let right = -1
  let sumY = 0
  let n = 0
  for (let y = region.y0; y < region.y1; y++) {
    for (let x = region.x0; x < region.x1; x++) {
      const i = (y * width + x) * 3
      if (rgb[i]! > 150 || rgb[i + 1]! > 150) {
        top = Math.min(top, y)
        bottom = Math.max(bottom, y)
        left = Math.min(left, x)
        right = Math.max(right, x)
        sumY += y
        n++
      }
    }
  }
  if (n === 0) throw new Error('no text found in the rendered frame')
  return { top, bottom, left, right, centreY: sumY / n }
}

describe.skipIf(!ffmpeg || !ffprobe)('dragged captions and chat land where the preview puts them (real FFmpeg)', () => {
  it('places captions at the mapped height in 9:16 and 16:9, and moves them by exactly the dragged amount', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-placement-'))
    try {
      mkdirSync(join(dir, 'fonts'))
      copyFileSync(font, join(dir, 'fonts', 'Montserrat-Black.ttf'))
      await runTool(ffmpeg!, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `color=c=black:size=${source.width}x${source.height}:rate=30:duration=4`, '-pix_fmt', 'yuv420p', join(dir, 'in.mp4')])

      for (const format of ['vertical', 'horizontal'] as const) {
        const out = OUTPUT_SIZE[format]
        const centres: number[] = []
        const settings = format === 'vertical' ? [{ y: 0.72 }, { y: 0.4 }, { y: 0.15 }] : [{ y: 0.72 }, { y: 0.72, yHorizontal: 0.4 }, { y: 0.72, yHorizontal: 0.15 }]
        for (const captions of settings) {
          const y = captionY(captions, format)
          const found = await renderBright(dir, format, buildAss(words, defaultAssStyle(format, y, true)), { x0: 0, x1: out.width, y0: 0, y1: out.height })
          // Centred on the frame horizontally, and near the mapped height (a caps-only line sits close to the middle of its box).
          expect((found.left + found.right) / 2).toBeGreaterThan(out.width / 2 - 20)
          expect((found.left + found.right) / 2).toBeLessThan(out.width / 2 + 20)
          expect(Math.abs(found.centreY - y * out.height)).toBeLessThan(out.height * 0.03)
          centres.push(found.centreY)
        }
        // Moving the caption by a mapped amount moves the pixels by the same amount.
        const y0 = captionY(settings[0]!, format)
        const y1 = captionY(settings[1]!, format)
        const y2 = captionY(settings[2]!, format)
        expect(Math.abs(centres[1]! - centres[0]! - (y1 - y0) * out.height)).toBeLessThan(3)
        expect(Math.abs(centres[2]! - centres[0]! - (y2 - y0) * out.height)).toBeLessThan(3)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)

  it('places the chat box at the dragged position in 9:16 and 16:9', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-placement-chat-'))
    try {
      mkdirSync(join(dir, 'fonts'))
      copyFileSync(font, join(dir, 'fonts', 'Montserrat-Black.ttf'))
      await runTool(ffmpeg!, ['-hide_banner', '-y', '-f', 'lavfi', '-i', `color=c=black:size=${source.width}x${source.height}:rate=30:duration=4`, '-pix_fmt', 'yuv420p', join(dir, 'in.mp4')])

      for (const format of ['vertical', 'horizontal'] as const) {
        const out = OUTPUT_SIZE[format]
        const boxes: { x: number; y: number; w: number; h: number; found: Bright }[] = []
        for (const pos of [null, { x: 0.08, y: 0.45 }]) {
          const geometry = chatOverlayGeometry(format, layout, source, null, DEFAULT_CHAT_OVERLAY_OPTIONS, pos)
          const lines = buildChatOverlay(chat, 0, 3, geometry)
          expect(lines.length).toBeGreaterThan(0)
          const ass = buildAss([], defaultAssStyle(format, 0.72, true), { lines, font: { fontName: 'Montserrat Black', fontSize: DEFAULT_CHAT_OVERLAY_OPTIONS.fontSize } })
          const found = await renderBright(dir, format, ass, { x0: 0, x1: out.width, y0: 0, y1: out.height })
          // The text is inside the box and hugs its right edge (right-aligned).
          expect(found.left).toBeGreaterThanOrEqual(geometry.x - 2)
          expect(found.right).toBeLessThanOrEqual(geometry.x + geometry.w + 2)
          expect(found.right).toBeGreaterThan(geometry.x + geometry.w - out.width * 0.08)
          expect(found.top).toBeGreaterThanOrEqual(geometry.y - 2)
          expect(found.bottom).toBeLessThanOrEqual(geometry.y + geometry.h + 2)
          boxes.push({ x: geometry.x, y: geometry.y, w: geometry.w, h: geometry.h, found })
        }
        // The dragged box put the same text exactly where the mapping moved it.
        const [home, moved] = boxes as [(typeof boxes)[number], (typeof boxes)[number]]
        expect(moved.x).toBe(Math.round(0.08 * out.width))
        expect(moved.y).toBe(Math.round(0.45 * out.height))
        expect(moved.found.right - home.found.right).toBe(moved.x + moved.w - (home.x + home.w))
        expect(moved.found.top - moved.y).toBeGreaterThanOrEqual(0)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
