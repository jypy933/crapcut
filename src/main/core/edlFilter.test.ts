import { describe, expect, it } from 'vitest'
import type { Layout } from '@shared/types'
import type { Edl, EdlSegment } from './edl'
import { atempoChain, buildEdlRenderArgs, buildOverlayAss, edlAudioFilter, edlToFilterGraph, edlVideoFilter, shakeAmpExpr, zoomCropExpr, zoomScaleExpr, type EdlRenderSpec } from './edlFilter'

const seg = (srcStart: number, srcEnd: number, speed = 1): EdlSegment => ({ srcStart, srcEnd, speed })

const baseEdl = (over: Partial<Edl> = {}): Edl => ({
  segments: [seg(0, 5)],
  zoom: [],
  freeze: [],
  overlays: [],
  sfx: [],
  ending: { kind: 'cut' },
  ...over
})

const layout: Layout = { id: 'l', name: 'Full', kind: 'center_crop', cam: null, game: { x: 0, y: 0, w: 1, h: 1 } }

const spec = (over: Partial<EdlRenderSpec> = {}): EdlRenderSpec => ({
  input: 'in.mp4',
  source: { width: 1920, height: 1080 },
  sourceFps: 60,
  format: 'horizontal',
  layout,
  edl: baseEdl(),
  captionsAssFile: null,
  overlayAssFile: null,
  fontsDir: null,
  audio: { kind: 'original' },
  loudness: null,
  encoder: 'libx264',
  filterScript: 'graph.txt',
  output: 'out.mp4',
  ...over
})

describe('atempoChain', () => {
  it('leaves normal speed alone', () => {
    expect(atempoChain(1)).toEqual([])
  })
  it('uses one atempo inside the 0.5-2x range', () => {
    expect(atempoChain(1.5)).toEqual(['atempo=1.5'])
    expect(atempoChain(0.75)).toEqual(['atempo=0.75'])
  })
  it('chains several atempo instances outside the range', () => {
    expect(atempoChain(4)).toEqual(['atempo=2', 'atempo=2'])
    expect(atempoChain(0.2)).toEqual(['atempo=0.5', 'atempo=0.5', 'atempo=0.8'])
  })
  it('rejects a non-positive speed', () => {
    expect(() => atempoChain(0)).toThrow()
    expect(() => atempoChain(-1)).toThrow()
  })
})

describe('zoomScaleExpr / shakeAmpExpr', () => {
  it('is a constant 1 with no keyframes', () => {
    expect(zoomScaleExpr([])).toBe('1')
    expect(shakeAmpExpr([])).toBe('0')
  })
  it('holds the last keyframe after it and the first before it', () => {
    const zoom = [
      { t: 1, scale: 1, ease: 'snap' as const },
      { t: 2, scale: 1.4, ease: 'snap' as const }
    ]
    const expr = zoomScaleExpr(zoom)
    expect(expr).toContain('if(lt(t,1)')
    expect(expr).toContain('if(lt(t,2)')
    expect(expr).toContain('1.4')
  })
  it('ramps between smooth keyframes', () => {
    const zoom = [
      { t: 0, scale: 1, ease: 'smooth' as const },
      { t: 1, scale: 2, ease: 'smooth' as const }
    ]
    expect(zoomScaleExpr(zoom)).toContain('(t-0)')
  })
  it('carries the shake amplitude of the active keyframe', () => {
    const zoom = [
      { t: 0, scale: 1, ease: 'snap' as const, shakeAmp: 6 },
      { t: 1, scale: 1.3, ease: 'snap' as const }
    ]
    expect(shakeAmpExpr(zoom)).toContain('6')
  })
})

describe('zoomCropExpr', () => {
  it('shrinks the crop by the scale and centres it, clamped to the frame', () => {
    const { w, h, x, y } = zoomCropExpr([{ t: 0, scale: 1, ease: 'snap' }], { width: 1000, height: 2000 })
    expect(w).toContain('1000/')
    expect(h).toContain('2000/')
    expect(x).toContain('max(0,min(')
    expect(y).toContain('max(0,min(')
  })
})

describe('edlVideoFilter', () => {
  it('builds segment trim + concat for a single segment, ending in [vout]', () => {
    const f = edlVideoFilter(spec())
    expect(f).toContain('trim=start=0.000000:end=5.000000')
    expect(f).toContain('concat=n=1:v=1:a=0')
    expect(f).toContain('[vout]')
    expect(f).not.toContain('crop=w=')
  })

  it('splits the input once per segment for a reorder', () => {
    const f = edlVideoFilter(spec({ edl: baseEdl({ segments: [seg(10, 12), seg(0, 20)] }) }))
    expect(f).toContain('split=2')
    expect(f).toContain('concat=n=2:v=1:a=0')
  })

  it('adds the punch-in crop and shake when there is a zoom', () => {
    const f = edlVideoFilter(spec({ edl: baseEdl({ zoom: [{ t: 0, scale: 1.5, ease: 'snap', shakeAmp: 5 }] }) }))
    expect(f).toContain('crop=w=')
    expect(f).toContain('sin(2*PI*13*t)')
  })

  it('splices a held frame for a freeze', () => {
    const f = edlVideoFilter(spec({ edl: baseEdl({ segments: [seg(0, 10)], freeze: [{ atOutputT: 4, holdSec: 1 }] }) }))
    expect(f).toContain('tpad=stop_mode=clone')
    expect(f).toContain('concat=n=3:v=1:a=0')
  })

  it('chains atempo (via the audio side) and setpts speed scaling for a fast segment', () => {
    const f = edlVideoFilter(spec({ edl: baseEdl({ segments: [seg(0, 10, 2)] }) }))
    expect(f).toContain('setpts=(PTS-STARTPTS)/2')
  })

  it('burns in captions and overlay ass files, never drawtext', () => {
    const f = edlVideoFilter(spec({ captionsAssFile: 'captions.ass', overlayAssFile: 'overlay.ass' }))
    expect(f).toContain('ass=captions.ass')
    expect(f).toContain('ass=overlay.ass')
    expect(f).not.toContain('drawtext')
  })

  it('splices a short tail/head crossfade for a loop ending, not a full-length xfade', () => {
    const f = edlVideoFilter(spec({ edl: baseEdl({ segments: [seg(0, 10)], ending: { kind: 'loop', introSec: 2, crossfadeSec: 0.5 } }) }))
    expect(f).toContain('xfade=transition=fade:duration=0.500000:offset=0')
    // The crossfade only ever sees the short head/tail sub-clips, not the whole 10s body.
    expect(f).toContain('trim=start=9.500000:end=10.000000')
    expect(f).toContain('trim=start=0.000000:end=2.000000')
  })

  it('trims to the exact computed output duration as a final safety net', () => {
    const f = edlVideoFilter(spec({ edl: baseEdl({ segments: [seg(0, 10)], freeze: [{ atOutputT: 4, holdSec: 1 }] }) }))
    expect(f).toContain('trim=start=0.000000:end=11.000000')
  })
})

describe('edlAudioFilter', () => {
  it('is silent with no inputs when the audio plan is silent', () => {
    expect(edlAudioFilter(spec({ audio: { kind: 'silent' } }))).toEqual({ inputs: [], filter: null })
  })

  it('normalises and loudnorms the original audio', () => {
    const a = edlAudioFilter(spec())
    expect(a.inputs).toEqual([])
    expect(a.filter).toContain('[0:a]')
    expect(a.filter).toContain('loudnorm=I=-14')
    expect(a.filter).toContain('[aout]')
  })

  it('mixes voice and quieter game for stems', () => {
    const a = edlAudioFilter(spec({ audio: { kind: 'stems', voice: 'v.wav', game: 'g.wav', gameGain: 0.3, music: null, musicGain: 0 } }))
    expect(a.inputs).toEqual([['-i', 'v.wav'], ['-i', 'g.wav']])
    expect(a.filter).toContain('volume=0.300')
    expect(a.filter).toContain('amix=inputs=2')
  })

  it('loops and ducks music under the voice', () => {
    const a = edlAudioFilter(spec({ audio: { kind: 'stems', voice: 'v.wav', game: null, gameGain: 0, music: 'm.mp3', musicGain: 0.25 } }))
    expect(a.inputs).toContainEqual(['-stream_loop', '-1', '-i', 'm.mp3'])
    expect(a.filter).toContain('sidechaincompress')
  })

  it('mixes in every sfx cue with adelay, normalize=0', () => {
    const a = edlAudioFilter(
      spec({ edl: baseEdl({ segments: [seg(0, 10)], sfx: [{ t: 2, file: 'boing.wav', gainDb: -3 }, { t: 4, file: 'whoosh.wav', gainDb: 0 }] }) })
    )
    expect(a.inputs).toContainEqual(['-i', 'boing.wav'])
    expect(a.filter).toContain('adelay=2000|2000')
    expect(a.filter).toContain('adelay=4000|4000')
    expect(a.filter).toContain('volume=-3dB')
    expect(a.filter).toContain('amix=inputs=3:duration=first:normalize=0')
  })

  it('fills silence for a freeze hold', () => {
    const a = edlAudioFilter(spec({ edl: baseEdl({ segments: [seg(0, 10)], freeze: [{ atOutputT: 4, holdSec: 1 }] }) }))
    expect(a.filter).toContain('anullsrc=r=48000:cl=stereo:d=1.000000')
  })
})

describe('edlToFilterGraph / buildEdlRenderArgs', () => {
  it('joins the video and audio graphs and collects the extra audio inputs', () => {
    const s = spec({ audio: { kind: 'stems', voice: 'v.wav', game: null, gameGain: 0, music: null, musicGain: 0 } })
    const { graph, audioInputs } = edlToFilterGraph(s)
    expect(graph).toContain('[vout]')
    expect(graph).toContain('[aout]')
    expect(audioInputs).toEqual([['-i', 'v.wav']])
  })

  it('passes the graph through -filter_complex_script, never inline', () => {
    const args = buildEdlRenderArgs(spec())
    expect(args).toContain('-filter_complex_script')
    expect(args).toContain('graph.txt')
    expect(args).not.toContain('-filter_complex')
  })

  it('places extra audio inputs after the main input', () => {
    const args = buildEdlRenderArgs(spec({ audio: { kind: 'stems', voice: 'v.wav', game: 'g.wav', gameGain: 0.3, music: null, musicGain: 0 } }))
    expect(args.slice(0, 6)).toEqual(['-hide_banner', '-nostdin', '-y', '-i', 'in.mp4', '-i'])
    expect(args).toContain('v.wav')
    expect(args).toContain('g.wav')
  })

  it('drops the audio map and uses -an when silent', () => {
    const args = buildEdlRenderArgs(spec({ audio: { kind: 'silent' } }))
    expect(args).toContain('-an')
    expect(args).not.toContain('[aout]')
  })

  it('uses the chosen encoder', () => {
    expect(buildEdlRenderArgs(spec({ encoder: 'h264_nvenc' }))).toContain('h264_nvenc')
  })

  it('adds -ss/-t before the main input only when seek/duration are given', () => {
    const plain = buildEdlRenderArgs(spec())
    expect(plain).not.toContain('-ss')
    expect(plain).not.toContain('-t')

    const seeked = buildEdlRenderArgs(spec({ seek: 12.5, duration: 8 }))
    expect(seeked.slice(0, 9)).toEqual(['-hide_banner', '-nostdin', '-y', '-ss', '12.500', '-t', '8.000', '-i', 'in.mp4'])
  })
})

describe('buildOverlayAss', () => {
  it('is empty of dialogue with no cues but still a valid script', () => {
    const ass = buildOverlayAss([], { width: 1080, height: 1920, fontName: 'Segoe UI', fontSize: 40 })
    expect(ass).toContain('[Script Info]')
    expect(ass).toContain('Style: QuoteBar,')
    expect(ass).toContain('Style: ChatBubble,')
    expect(ass).not.toContain('Dialogue:')
  })

  it('writes one Dialogue line per cue, positioned and escaped, in time order', () => {
    const ass = buildOverlayAss(
      [
        { kind: 'chatBubble', t0: 2, t1: 3, text: 'no way {this} happened\\', pos: { x: 0.5, y: 0.8, align: 'left' } },
        { kind: 'quoteBar', t0: 0, t1: 1, text: 'clip it', pos: { x: 0.5, y: 0.2, align: 'center' } }
      ],
      { width: 1080, height: 1920, fontName: 'Segoe UI', fontSize: 40 }
    )
    const lines = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('QuoteBar')
    expect(lines[0]).toContain('clip it')
    expect(lines[1]).toContain('ChatBubble')
    expect(lines[1]).toContain('(this)')
    expect(lines[1]).not.toContain('\\}')
    expect(lines[1]).toContain('\\pos(540,1536)')
  })
})
