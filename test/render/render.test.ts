// Renders tiny generated clips with the real FFmpeg and checks the results.
// Skips when FFmpeg is not installed.

import { copyFileSync, mkdirSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildAss, defaultAssStyle } from '../../src/main/core/ass'
import { buildLoudnessMeasureArgs, buildRenderArgs, parseLoudnessMeasure, type RenderSpec } from '../../src/main/core/render'
import type { Layout } from '../../src/shared/types'
import { awkwardTempDir, FFMPEG, ffmpeg, hasFfmpeg, makeTestVideo, makeTone, probe } from './helpers'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)
const FONT = resolve(__dirname, '../../resources/fonts/Montserrat-Black.ttf')

describe.skipIf(!hasFfmpeg)('render with FFmpeg', () => {
  let dir = ''
  let cleanup = (): void => {}
  let source = ''

  beforeAll(async () => {
    ;({ dir, cleanup } = awkwardTempDir())
    source = join(dir, 'source clip.mp4')
    await makeTestVideo(source, 6)
    mkdirSync(join(dir, 'fonts'))
    copyFileSync(FONT, join(dir, 'fonts', 'Montserrat-Black.ttf'))
    const words = [
      { t0: 0.2, t1: 0.6, text: 'this' },
      { t0: 0.6, t1: 1.0, text: 'is' },
      { t0: 1.0, t1: 1.6, text: "Zoë's" },
      { t0: 1.8, t1: 2.4, text: 'clip!' }
    ]
    writeFileSync(join(dir, 'vertical.ass'), buildAss(words, defaultAssStyle('vertical', 0.66, true)))
    writeFileSync(join(dir, 'horizontal.ass'), buildAss(words, defaultAssStyle('horizontal', 0.85, true)))
  }, 120_000)

  afterAll(() => {
    if (process.env.CRAPCUT_KEEP_RENDERS) console.log('renders kept in', dir)
    else cleanup()
  })

  const layout: Layout = { id: 'l', name: 'Cam', kind: 'cam_game', cam: { x: 0.7, y: 0.65, w: 0.3, h: 0.35 }, game: { x: 0, y: 0, w: 1, h: 1 } }

  const spec = (over: Partial<RenderSpec>): RenderSpec => ({
    input: source,
    seek: 1,
    duration: 4,
    source: { width: 1920, height: 1080 },
    sourceFps: 60,
    format: 'vertical',
    layout,
    assFile: 'vertical.ass',
    fontsDir: 'fonts',
    audio: { kind: 'original' },
    loudness: null,
    encoder: 'libx264',
    output: join(dir, 'out.mp4'),
    ...over
  })

  async function render(s: RenderSpec): Promise<string> {
    const { stderr } = await run(FFMPEG, ['-v', 'verbose', ...buildRenderArgs(s)], { cwd: dir, maxBuffer: 64 * 1024 * 1024, windowsHide: true })
    return stderr
  }

  it('renders a vertical cam + game clip with captions', async () => {
    const out = join(dir, 'vertical out.mp4')
    const stderr = await render(spec({ output: out }))
    const p = await probe(out)
    expect(p.video).toMatchObject({ width: 1080, height: 1920, codec: 'h264' })
    expect(p.video!.fps).toBeCloseTo(60, 0)
    expect(p.duration).toBeGreaterThan(3.9)
    expect(p.duration).toBeLessThan(4.15)
    expect(p.audio).toMatchObject({ codec: 'aac', sampleRate: 48000, channels: 2 })
    expect(statSync(out).size).toBeGreaterThan(50_000)
    // libass found the bundled caption font.
    expect(stderr).toMatch(/Montserrat/i)
  }, 120_000)

  it('renders a horizontal clip', async () => {
    const out = join(dir, 'horizontal.mp4')
    await render(spec({ format: 'horizontal', assFile: 'horizontal.ass', output: out }))
    const p = await probe(out)
    expect(p.video).toMatchObject({ width: 1920, height: 1080 })
    expect(p.duration).toBeCloseTo(4, 0)
  }, 120_000)

  it('renders blur fill and centre crop layouts', async () => {
    for (const kind of ['blur_fill', 'center_crop'] as const) {
      const out = join(dir, `${kind}.mp4`)
      await render(spec({ layout: { ...layout, kind, cam: null }, assFile: null, output: out }))
      expect((await probe(out)).video).toMatchObject({ width: 1080, height: 1920 })
    }
  }, 120_000)

  it('mixes voice, game and looped music stems', async () => {
    const voice = join(dir, 'voice.wav')
    const game = join(dir, 'game.wav')
    const music = join(dir, 'music.wav')
    await makeTone(voice, 4, 300)
    await makeTone(game, 4, 800)
    await makeTone(music, 1.5, 500)
    const out = join(dir, 'stems.mp4')
    await render(spec({ audio: { kind: 'stems', voice, game, gameGain: 0.3, music, musicGain: 0.25 }, output: out }))
    const p = await probe(out)
    expect(p.audio).toMatchObject({ channels: 2 })
    expect(p.duration).toBeCloseTo(4, 0)
  }, 120_000)

  it('measures loudness for a two-pass export', async () => {
    const { stderr } = await ffmpeg(buildLoudnessMeasureArgs(source, 1, 4).slice(2))
    const m = parseLoudnessMeasure(stderr)
    expect(m).not.toBeNull()
    const out = join(dir, 'two-pass.mp4')
    await render(spec({ loudness: m, output: out }))
    expect((await probe(out)).audio).not.toBeNull()
  }, 120_000)
})
