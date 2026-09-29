import { describe, expect, it } from 'vitest'
import type { Layout } from '@shared/types'
import {
  audioFilter,
  buildRenderArgs,
  encoderArgs,
  filterValue,
  fitAspect,
  parseLoudnessMeasure,
  parseProgressSeconds,
  toPixels,
  verticalGeometry,
  videoFilter,
  type RenderSpec
} from './render'

const src = { width: 1920, height: 1080 }
const full = { x: 0, y: 0, w: 1, h: 1 }
const camGame: Layout = { id: 'l', name: 'Cam', kind: 'cam_game', cam: { x: 0.75, y: 0.7, w: 0.25, h: 0.3 }, game: full }

const spec = (over: Partial<RenderSpec> = {}): RenderSpec => ({
  input: 'C:\\clips\\src.mp4',
  seek: 12.5,
  duration: 30,
  source: src,
  sourceFps: 60,
  format: 'vertical',
  layout: camGame,
  assFile: 'captions.ass',
  fontsDir: 'fonts',
  audio: { kind: 'original' },
  loudness: null,
  encoder: 'libx264',
  output: 'C:\\out\\clip.mp4',
  ...over
})

describe('geometry', () => {
  it('converts to even pixels inside the frame', () => {
    expect(toPixels({ x: 0.75, y: 0.7, w: 0.25, h: 0.3 }, src)).toEqual({ x: 1440, y: 756, w: 480, h: 324 })
    const edge = toPixels({ x: 0.9, y: 0.9, w: 0.5, h: 0.5 }, src)
    expect(edge.x + edge.w).toBeLessThanOrEqual(1920)
    expect(edge.y + edge.h).toBeLessThanOrEqual(1080)
    expect(edge.w % 2).toBe(0)
  })

  it('fits an aspect ratio centred inside a rect', () => {
    const r = fitAspect({ x: 0, y: 0, w: 1920, h: 1080 }, 9 / 16, src)
    expect(r.h).toBe(1080)
    expect(r.w).toBe(608)
    expect(r.x).toBe(656)
  })

  it('stacks cam over game filling 1080x1920', () => {
    const g = verticalGeometry(camGame, src)
    expect(g.camHeight + g.gameHeight).toBe(1920)
    expect(g.camHeight).toBeGreaterThanOrEqual(480)
    expect(g.camHeight).toBeLessThanOrEqual(864)
    expect(g.cam!.w / g.cam!.h).toBeCloseTo(1080 / g.camHeight, 1)
    expect(g.game.w / g.game.h).toBeCloseTo(1080 / g.gameHeight, 1)
  })

  it('uses a centre crop without a cam', () => {
    const g = verticalGeometry({ ...camGame, kind: 'center_crop', cam: null }, src)
    expect(g.cam).toBeNull()
    expect(g.gameHeight).toBe(1920)
  })
})

describe('videoFilter', () => {
  it('builds the cam + game graph with captions', () => {
    const f = videoFilter(spec())
    expect(f).toContain('split=2[camsrc][gamesrc]')
    expect(f).toContain('vstack=inputs=2')
    expect(f).toContain('fps=60,ass=captions.ass:fontsdir=fonts,format=yuv420p[vout]')
  })
  it('builds blur fill and horizontal graphs', () => {
    expect(videoFilter(spec({ layout: { ...camGame, kind: 'blur_fill' } }))).toContain('gblur')
    const h = videoFilter(spec({ format: 'horizontal', assFile: null }))
    expect(h).toContain('scale=1920:1080')
    expect(h).not.toContain('ass=')
  })
  it('blurs the fill background at a quarter of the size and scales it back up', () => {
    const f = videoFilter(spec({ layout: { ...camGame, kind: 'blur_fill' } }))
    expect(f).toContain('scale=270:480:force_original_aspect_ratio=increase:flags=bilinear,crop=270:480,gblur=sigma=6,eq=brightness=-0.06,scale=1080:1920:flags=bilinear[bg]')
    // The sharp foreground keeps its full-size lanczos scale.
    expect(f).toContain('[fgsrc]scale=1080:-2:flags=lanczos[fg]')
  })
  it('scales the layout to a smaller output size, keeping the proportions', () => {
    const small = { width: 360, height: 640 }
    const cam = videoFilter(spec({ outputSize: small }))
    const g = verticalGeometry(camGame, src)
    const camHeight = Math.round((g.camHeight * 640) / 1920 / 2) * 2
    expect(cam).toContain(`scale=360:${camHeight}:flags=lanczos`)
    expect(cam).toContain(`scale=360:${640 - camHeight}:flags=lanczos`)
    const blur = videoFilter(spec({ layout: { ...camGame, kind: 'blur_fill' }, outputSize: small }))
    expect(blur).toContain('scale=90:160:force_original_aspect_ratio=increase:flags=bilinear,crop=90:160,gblur=sigma=2,')
    expect(blur).toContain('scale=360:640:flags=bilinear[bg]')
    expect(videoFilter(spec({ format: 'horizontal', outputSize: { width: 640, height: 360 } }))).toContain('scale=640:360:flags=lanczos')
  })
  it('caps the frame rate', () => {
    expect(videoFilter(spec({ sourceFps: 144 }))).toContain('fps=60')
    expect(videoFilter(spec({ sourceFps: 0 }))).toContain('fps=30')
  })
})

describe('filterValue', () => {
  it('passes simple names and quotes anything else', () => {
    expect(filterValue('captions.ass')).toBe('captions.ass')
    expect(filterValue("C:\\Users\\O'Neil\\a b.ass")).toBe("'C\\:/Users/O'\\''Neil/a b.ass'")
  })
})

describe('audioFilter', () => {
  it('normalises the original audio', () => {
    const a = audioFilter(spec())
    expect(a.inputs).toEqual([])
    expect(a.filter).toContain('[0:a]')
    expect(a.filter).toContain('loudnorm=I=-14')
  })
  it('uses a measured second pass when available', () => {
    const a = audioFilter(spec({ loudness: { inputI: -20, inputTp: -3, inputLra: 5, inputThresh: -30, targetOffset: 0.5 } }))
    expect(a.filter).toContain('measured_I=-20')
    expect(a.filter).toContain('linear=true')
  })
  it('mixes voice, quieter game and ducked music', () => {
    const a = audioFilter(spec({ audio: { kind: 'stems', voice: 'v.wav', game: 'g.wav', gameGain: 0.3, music: 'm.mp3', musicGain: 0.25 } }))
    expect(a.inputs).toEqual([['-i', 'v.wav'], ['-i', 'g.wav'], ['-stream_loop', '-1', '-i', 'm.mp3']])
    expect(a.filter).toContain('volume=0.300[game]')
    expect(a.filter).toContain('sidechaincompress')
    expect(a.filter).toContain('amix=inputs=3')
  })
  it('handles voice only and silence', () => {
    expect(audioFilter(spec({ audio: { kind: 'stems', voice: 'v.wav', game: null, gameGain: 0, music: null, musicGain: 0 } })).filter).toContain(
      '[voice]loudnorm'
    )
    expect(audioFilter(spec({ audio: { kind: 'silent' } })).filter).toBeNull()
  })
})

describe('buildRenderArgs', () => {
  it('seeks, maps and encodes', () => {
    const args = buildRenderArgs(spec())
    expect(args.slice(0, 9)).toEqual(['-hide_banner', '-nostdin', '-y', '-ss', '12.500', '-t', '30.000', '-i', 'C:\\clips\\src.mp4'])
    expect(args).toContain('[vout]')
    expect(args).toContain('[aout]')
    expect(args[args.length - 1]).toBe('C:\\out\\clip.mp4')
    expect(args.join(' ')).toContain('-c:v libx264')
  })
  it('drops audio when silent', () => {
    expect(buildRenderArgs(spec({ audio: { kind: 'silent' } }))).toContain('-an')
  })
  it('has settings for every encoder', () => {
    for (const e of ['h264_nvenc', 'h264_amf', 'h264_qsv', 'libx264'] as const) expect(encoderArgs(e, 60)).toContain(e)
  })
  it('uses the veryfast preset on the CPU fallback', () => {
    expect(encoderArgs('libx264', 60).join(' ')).toContain('-preset veryfast -crf 20')
  })
})

describe('output parsers', () => {
  it('reads loudnorm JSON', () => {
    const stderr = `[Parsed_loudnorm_0 @ 0000] \n{\n "input_i" : "-23.54",\n "input_tp" : "-7.12",\n "input_lra" : "4.50",\n "input_thresh" : "-33.80",\n "target_offset" : "0.26"\n}\n`
    expect(parseLoudnessMeasure(stderr)).toEqual({ inputI: -23.54, inputTp: -7.12, inputLra: 4.5, inputThresh: -33.8, targetOffset: 0.26 })
    expect(parseLoudnessMeasure('{"input_i":"-inf","input_tp":"-inf","input_lra":"0","input_thresh":"-70","target_offset":"0"}')).toBeNull()
    expect(parseLoudnessMeasure('nothing')).toBeNull()
  })
  it('reads progress', () => {
    expect(parseProgressSeconds('frame=10\nout_time_us=1500000\nprogress=continue\nout_time_us=2500000\n')).toBe(2.5)
    expect(parseProgressSeconds('frame=1')).toBeNull()
  })
})
