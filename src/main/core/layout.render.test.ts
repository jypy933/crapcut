// Renders a cam + game layout from a synthetic frame (a red "facecam" patch on
// green) with the real export arguments and checks where the colours land, so
// the layout geometry is proven end to end and not only as filter strings.
// Skips cleanly when FFmpeg is not on PATH.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { layoutPlan, normalizeLayout, OUTPUT_SIZE, toPixels } from '@shared/layoutGeometry'
import type { Layout } from '@shared/types'
import { buildRenderArgs, type RenderSpec } from './render'
import { probeMedia } from '../pipeline/media'
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
// The cam sits on the right; the game area is on the left and never touches it.
const drawn: Layout = { id: 'layout-render', name: 'Cam', kind: 'cam_game', cam: { x: 0.7, y: 0.05, w: 0.28, h: 0.3 }, game: { x: 0.05, y: 0, w: 0.6, h: 1 } }

const px = (rgb: Buffer, width: number, x: number, y: number): [number, number, number] => {
  const i = (y * width + x) * 3
  return [rgb[i]!, rgb[i + 1]!, rgb[i + 2]!]
}
const isRed = ([r, g, b]: [number, number, number]): boolean => r > 180 && g < 90 && b < 90
const isGreen = ([r, g, b]: [number, number, number]): boolean => g > 100 && r < 90 && b < 90

describe.skipIf(!ffmpeg || !ffprobe)('cam + game layout geometry (real FFmpeg)', () => {
  it('puts exactly the marked cam on top and the marked game below, for a normalised layout', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-layout-'))
    try {
      const cam = toPixels(drawn.cam!, source)
      await runTool(ffmpeg!, [
        '-hide_banner',
        '-y',
        '-f',
        'lavfi',
        '-i',
        `color=c=green:size=${source.width}x${source.height}:rate=30:duration=1`,
        '-f',
        'lavfi',
        '-i',
        `color=c=red:size=${cam.w}x${cam.h}:rate=30:duration=1`,
        '-filter_complex',
        `[0:v][1:v]overlay=${cam.x}:${cam.y},format=yuv420p`,
        '-c:v',
        'libx264',
        '-crf',
        '10',
        join(dir, 'in.mp4')
      ])

      // What the editor would save, then what the export makes of it.
      const layout = normalizeLayout(drawn, source)
      const spec: RenderSpec = {
        input: 'in.mp4',
        seek: 0,
        duration: 1,
        source,
        sourceFps: 30,
        format: 'vertical',
        layout,
        assFile: null,
        fontsDir: null,
        audio: { kind: 'silent' },
        loudness: null,
        encoder: 'libx264',
        output: 'out.mp4'
      }
      await runTool(ffmpeg!, buildRenderArgs(spec), { cwd: dir })

      const out = await probeMedia(ffprobe!, join(dir, 'out.mp4'))
      expect(out.width).toBe(OUTPUT_SIZE.vertical.width)
      expect(out.height).toBe(OUTPUT_SIZE.vertical.height)

      await runTool(ffmpeg!, ['-hide_banner', '-y', '-i', 'out.mp4', '-frames:v', '1', '-f', 'rawvideo', '-pix_fmt', 'rgb24', 'frame.rgb'], { cwd: dir })
      const rgb = readFileSync(join(dir, 'frame.rgb'))
      const W = OUTPUT_SIZE.vertical.width
      const plan = layoutPlan(layout, 'vertical', source)
      if (plan.mode !== 'stack') throw new Error('expected a stacked layout')

      // The whole cam slot is the cam patch (nothing of the game around it), the rest is the game.
      const inset = 12
      for (const [x, y] of [[inset, inset], [W - inset, inset], [inset, plan.camHeight - inset], [W - inset, plan.camHeight - inset], [W / 2, plan.camHeight / 2]] as const) {
        expect(isRed(px(rgb, W, x, y))).toBe(true)
      }
      for (const [x, y] of [[inset, plan.camHeight + inset], [W - inset, plan.camHeight + inset], [inset, 1920 - inset], [W - inset, 1920 - inset], [W / 2, 1300]] as const) {
        expect(isGreen(px(rgb, W, x, y))).toBe(true)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
