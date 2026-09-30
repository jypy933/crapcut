// Runs the export checks on tiny synthetic files made with FFmpeg (testsrc2,
// sine, anullsrc): a proper 9:16 export passes, a letterboxed one, a silent one
// and a wrong-sized one are flagged, and a real export render of a source with
// baked-in bars is caught. Skips cleanly when FFmpeg is not on PATH.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Layout } from '@shared/types'
import { SAFE_ZONES } from '@shared/captionSafeZone'
import { evaluateExport, type ExportExpectations } from '../core/exportChecks'
import { buildRenderArgs, type RenderSpec } from '../core/render'
import { runTool } from '../tools/process'
import { measureExport } from './exportChecks'

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

const expects = (over: Partial<ExportExpectations> = {}): ExportExpectations => ({
  format: 'vertical',
  sourceHadAudio: true,
  sourceSilent: false,
  plannedMaxSec: 3,
  ass: null,
  zone: SAFE_ZONES.reels,
  layoutIsBlur: false,
  ...over
})

describe.skipIf(!ffmpeg || !ffprobe)('export checks on real files (FFmpeg)', () => {
  let dir = ''
  const make = async (name: string, args: string[]): Promise<string> => {
    await runTool(ffmpeg!, ['-hide_banner', '-y', ...args, '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-t', '3', join(dir, name)])
    return join(dir, name)
  }
  const testsrc = (size: string): string[] => ['-f', 'lavfi', '-i', `testsrc2=size=${size}:rate=30`]
  const sine = ['-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000']
  const silence = ['-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo']
  const measure = (file: string) => measureExport(ffmpeg!, ffprobe!, file)

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), 'crapcut-exportchecks-'))
  })
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('passes a proper full-frame 1080x1920 clip with sound', async () => {
    const file = await make('good.mp4', [...testsrc('1080x1920'), ...sine])
    const r = evaluateExport(await measure(file), expects())
    expect(r.checks.filter((c) => !c.ok)).toEqual([])
    expect(r).toMatchObject({ broken: null, fix: null })
  }, 60_000)

  it('flags a 16:9 picture letterboxed into 9:16 and offers the blurred fill', async () => {
    const file = await make('boxed.mp4', [...testsrc('1080x608'), ...sine, '-vf', 'pad=1080:1920:0:656:black'])
    const m = await measure(file)
    const r = evaluateExport(m, expects())
    const bars = r.checks.find((c) => c.id === 'bars')
    expect(bars?.ok).toBe(false)
    expect(bars?.detail).toContain('top')
    expect(r.fix).toBe('blur_fill')
    expect(r.broken).toBeNull()
    // The blurred fill has dark blurred edges by design: not judged, nothing further to swap in.
    expect(evaluateExport(m, expects({ layoutIsBlur: true })).fix).toBeNull()
  }, 60_000)

  it('flags a silent clip as broken, and only warns when the source was silent too', async () => {
    const file = await make('silent.mp4', [...testsrc('1080x1920'), ...silence])
    const m = await measure(file)
    expect(m.audio?.maxDb).toBeLessThan(-80)
    expect(evaluateExport(m, expects()).broken).toContain('silent')
    expect(evaluateExport(m, expects({ sourceSilent: true })).broken).toBeNull()
  }, 60_000)

  it('flags a clip with no audio stream at all', async () => {
    const file = await make('noaudio.mp4', [...testsrc('1080x1920'), '-an'])
    const m = await measure(file)
    expect(m.video.hasAudio).toBe(false)
    expect(evaluateExport(m, expects()).broken).toContain('no audio stream')
  }, 60_000)

  it('flags the wrong size', async () => {
    const file = await make('small.mp4', [...testsrc('720x1280'), ...sine])
    expect(evaluateExport(await measure(file), expects()).broken).toContain('720x1280')
  }, 60_000)

  it('checks a 16:9 export at 1920x1080', async () => {
    const file = await make('wide.mp4', [...testsrc('1920x1080'), ...sine])
    const r = evaluateExport(await measure(file), expects({ format: 'horizontal', zone: SAFE_ZONES.reels }))
    expect(r.checks.filter((c) => !c.ok)).toEqual([])
  }, 60_000)

  it('catches bars baked into a source when a crop layout renders them, and the blurred fill is not mistaken for bars', async () => {
    // A 16:9 source that already has black bars top and bottom.
    const source = await make('baked.mp4', [...testsrc('1280x520'), ...sine, '-vf', 'pad=1280:720:0:100:black'])
    const cropLayout: Layout = { id: 'crop', name: 'Crop', kind: 'cam_game', cam: null, game: { x: 0, y: 0, w: 1, h: 1 } }
    const blurLayout: Layout = { id: 'blur', name: 'Blur', kind: 'blur_fill', cam: null, game: { x: 0, y: 0, w: 1, h: 1 } }
    const spec = (layout: Layout, output: string): RenderSpec => ({
      input: source,
      seek: 0,
      duration: 2,
      source: { width: 1280, height: 720 },
      sourceFps: 30,
      format: 'vertical',
      layout,
      assFile: null,
      fontsDir: null,
      audio: { kind: 'original' },
      loudness: null,
      encoder: 'libx264',
      output
    })
    await runTool(ffmpeg!, buildRenderArgs(spec(cropLayout, join(dir, 'crop.mp4'))))
    await runTool(ffmpeg!, buildRenderArgs(spec(blurLayout, join(dir, 'blur.mp4'))))

    const cropped = evaluateExport(await measure(join(dir, 'crop.mp4')), expects({ plannedMaxSec: 2 }))
    expect(cropped.checks.find((c) => c.id === 'bars')?.ok).toBe(false)
    expect(cropped.fix).toBe('blur_fill')
    expect(cropped.broken).toBeNull()

    const blurred = evaluateExport(await measure(join(dir, 'blur.mp4')), expects({ plannedMaxSec: 2, layoutIsBlur: true }))
    expect(blurred.checks.find((c) => c.id === 'bars')?.ok).toBe(true)
    expect(blurred.broken).toBeNull()
  }, 90_000)
})
