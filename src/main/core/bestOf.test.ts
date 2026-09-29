import { describe, expect, it } from 'vitest'
import type { Clip, Layout } from '@shared/types'
import {
  buildBestOfGraph,
  buildBestOfRender,
  buildClipAudioArgs,
  clipLengthSec,
  keptClipsInOrder,
  planBestOfJoin,
  type BestOfAudioSource,
  type BestOfClip
} from './bestOf'
import { audioChain, type AudioPlan } from './render'

const plan = (durations: number[], crossfade = 0.5): ReturnType<typeof planBestOfJoin> => planBestOfJoin(durations.map((duration) => ({ duration })), crossfade)

const full = { x: 0, y: 0, w: 1, h: 1 }
const gameLayout: Layout = { id: 'l', name: 'Full', kind: 'blur_fill', cam: null, game: full }

const bestClip = (over: Partial<BestOfClip> = {}): BestOfClip => ({
  input: 'clips/a.mp4',
  seek: 2,
  duration: 10,
  source: { width: 1920, height: 1080 },
  layout: gameLayout,
  assFile: null,
  fontsDir: null,
  audioFile: 'clip-0.wav',
  ...over
})

const render = (clips: BestOfClip[], over: Partial<Parameters<typeof buildBestOfRender>[1]> = {}): ReturnType<typeof buildBestOfRender> =>
  buildBestOfRender(clips, { crossfadeSec: 0.5, encoder: 'libx264', filterScript: 'graph.txt', output: 'out.mp4', ...over })

/** Every `[label]` a graph writes, in order (the pads at the end of each `;`-separated chain). */
function outputLabels(graph: string): string[] {
  return graph.split(';').flatMap((seg) => [...(seg.match(/(?:\[[^\]]+\])+$/)?.[0].matchAll(/\[([^\]]+)\]/g) ?? [])].map((m) => m[1]!))
}

/** Every `[label]` a graph reads, in order (the pads at the start of each `;`-separated chain). */
function inputLabels(graph: string): string[] {
  return graph.split(';').flatMap((seg) => [...(seg.match(/^(?:\[[^\]]+\])+/)?.[0].matchAll(/\[([^\]]+)\]/g) ?? [])].map((m) => m[1]!))
}

/** A minimal fake Clip; only the fields keptClipsInOrder cares about vary per call. */
const fakeClip = (overrides: Partial<Clip> & { id: string }): Clip => ({
  jobId: 'job1',
  rank: 1,
  score: 0.5,
  title: overrides.id,
  start: 0,
  end: 30,
  suggested: { start: 0, end: 30 },
  source: null,
  status: 'accepted',
  words: [],
  captions: { enabled: true, y: 0.7, uppercase: true, styleId: 'clean' },
  chatMessages: [],
  chatOverlay: false,
  audio: 'original',
  musicPath: null,
  layoutId: null,
  formats: { vertical: true, horizontal: false },
  reason: 'Chat spike',
  signals: null,
  structureDecision: null,
  autoEdit: true,
  ...overrides
})

describe('keptClipsInOrder', () => {
  it('sorts by start time, not by rank', () => {
    // rank 1 is the finder's favourite (highest score), not the first clip in
    // the stream -- the strongest moment here happens latest in the VOD.
    const late = fakeClip({ id: 'late', rank: 1, start: 500 })
    const early = fakeClip({ id: 'early', rank: 3, start: 10 })
    const middle = fakeClip({ id: 'middle', rank: 2, start: 200 })
    expect(keptClipsInOrder([late, early, middle]).map((c) => c.id)).toEqual(['early', 'middle', 'late'])
  })

  it('drops pending and rejected clips', () => {
    const kept = fakeClip({ id: 'kept', start: 10, status: 'accepted' })
    const rejected = fakeClip({ id: 'rejected', start: 5, status: 'rejected' })
    const pending = fakeClip({ id: 'pending', start: 1, status: 'pending' })
    expect(keptClipsInOrder([kept, rejected, pending]).map((c) => c.id)).toEqual(['kept'])
  })

  it('does not mutate the input array', () => {
    const list = [fakeClip({ id: 'b', start: 20 }), fakeClip({ id: 'a', start: 10 })]
    const copy = [...list]
    keptClipsInOrder(list)
    expect(list).toEqual(copy)
  })
})

describe('planBestOfJoin', () => {
  it('has no transitions for zero or one clip', () => {
    expect(plan([])).toEqual({ transitions: [], totalDurationSec: 0 })
    expect(plan([10])).toEqual({ transitions: [], totalDurationSec: 10 })
  })

  it('overlaps each transition by the crossfade and shortens the total', () => {
    const p = plan([10, 8, 12])
    expect(p.transitions).toHaveLength(2)
    expect(p.transitions[0]).toEqual({ crossfadeSec: 0.5, offsetSec: 9.5 })
    expect(p.transitions[1]!.crossfadeSec).toBe(0.5)
    // 10 + 8 + 12 - 0.5 - 0.5
    expect(p.totalDurationSec).toBeCloseTo(29, 5)
  })

  it('clamps the crossfade for a clip shorter than the default', () => {
    // 40% of the 1s clip is the binding constraint.
    expect(plan([10, 1]).transitions[0]!.crossfadeSec).toBeCloseTo(0.4, 5)
  })

  it('falls back to a hard cut for a clip shorter than the crossfade floor', () => {
    const p = plan([10, 0.02])
    expect(p.transitions[0]!.crossfadeSec).toBe(0)
    expect(p.transitions[0]!.offsetSec).toBeCloseTo(10, 5)
    expect(p.totalDurationSec).toBeCloseTo(10.02, 5)
  })
})

describe('clipLengthSec', () => {
  it('rounds to a whole number of frames at 30 fps', () => {
    expect(clipLengthSec(10)).toBe(10)
    expect(clipLengthSec(10.01)).toBe(10)
    expect(clipLengthSec(10.02)).toBeCloseTo(10.0333333, 5)
    expect(clipLengthSec(0.001)).toBeCloseTo(1 / 30, 9)
  })
})

describe('buildBestOfGraph', () => {
  it('rejects an empty clip list', () => {
    expect(() => buildBestOfGraph([], 0.5)).toThrow()
  })

  it('builds a single clip with no crossfade', () => {
    const g = buildBestOfGraph([bestClip()], 0.5)
    expect(g.graph).not.toContain('xfade')
    expect(g.graph).not.toContain('acrossfade')
    expect(g.inputArgs).toEqual(['-ss', '2.000', '-t', '10.000', '-i', 'clips/a.mp4', '-i', 'clip-0.wav'])
    expect(g.videoLabel).toBe('v0')
    expect(g.audioLabel).toBe('a0')
    expect(g.graph).toContain('[0:v]crop=1916:1078:4:2,scale=1920:1080:flags=lanczos,setsar=1[c0base]')
    expect(g.graph).toContain('[c0base]fps=30,format=yuv420p,tpad=stop_mode=clone:stop=-1,trim=end_frame=300,setpts=PTS-STARTPTS[v0]')
    expect(g.graph).toContain('[1:a]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=10.000000,atrim=end=10.000000,asetpts=PTS-STARTPTS[a0]')
    expect(g.plan.totalDurationSec).toBe(10)
  })

  it('numbers the inputs clip by clip and chains the crossfades for three clips of different size', () => {
    const clips = [
      bestClip({ input: 'clips/a.mp4', seek: 1, duration: 10, source: { width: 1280, height: 720 }, audioFile: 'clip-0.wav' }),
      bestClip({ input: 'clips/b.mp4', seek: 3.5, duration: 8, source: { width: 1920, height: 1080 }, audioFile: 'clip-1.wav' }),
      bestClip({ input: 'clips/c.mp4', seek: 0, duration: 12, source: { width: 854, height: 480 }, audioFile: 'clip-2.wav' })
    ]
    const g = buildBestOfGraph(clips, 0.5)
    expect(g.inputArgs).toEqual([
      '-ss', '1.000', '-t', '10.000', '-i', 'clips/a.mp4', '-i', 'clip-0.wav',
      '-ss', '3.500', '-t', '8.000', '-i', 'clips/b.mp4', '-i', 'clip-1.wav',
      '-ss', '0.000', '-t', '12.000', '-i', 'clips/c.mp4', '-i', 'clip-2.wav'
    ])
    // Pictures from inputs 0, 2 and 4; sound from the WAVs at 1, 3 and 5.
    expect(g.graph).toContain('[0:v]crop=1276:718:4:2,')
    expect(g.graph).toContain('[2:v]crop=1916:1078:4:2,')
    expect(g.graph).toContain('[4:v]crop=850:478:4:2,')
    for (const [i, idx] of [[0, 1], [1, 3], [2, 5]] as const) expect(g.graph).toContain(`[${idx}:a]aresample=48000`)
    for (const i of [0, 1, 2]) expect(g.graph).toContain(`scale=1920:1080:flags=lanczos,setsar=1[c${i}base]`)
    // 10 + 8 - 0.5 = 17.5, so the second transition starts at 17.0.
    expect(g.graph).toContain('[v0][v1]xfade=transition=fade:duration=0.500:offset=9.500[vx1]')
    expect(g.graph).toContain('[vx1][v2]xfade=transition=fade:duration=0.500:offset=17.000[vx2]')
    expect(g.graph).toContain('[a0][a1]acrossfade=d=0.500[ax1]')
    expect(g.graph).toContain('[ax1][a2]acrossfade=d=0.500[ax2]')
    expect(g.videoLabel).toBe('vx2')
    expect(g.audioLabel).toBe('ax2')
    expect(g.plan.totalDurationSec).toBeCloseTo(29, 5)
  })

  it('writes every pad exactly once and reads it exactly once', () => {
    const clips = [
      bestClip({ assFile: 'clip-0-work/captions.ass', fontsDir: 'clip-0-work/fonts' }),
      bestClip({ layout: { ...gameLayout, kind: 'cam_game', cam: { x: 0.75, y: 0.7, w: 0.25, h: 0.3 } }, audioFile: null }),
      bestClip({ assFile: 'clip-2-work/captions.ass', fontsDir: 'clip-2-work/fonts' })
    ]
    const g = buildBestOfGraph(clips, 0.5)
    const written = outputLabels(g.graph)
    expect(new Set(written).size).toBe(written.length)
    const read = inputLabels(g.graph).filter((l) => !/^\d+:[av]$/.test(l))
    expect(new Set(read).size).toBe(read.length)
    // Everything written is read, except the two pads the encoder maps.
    expect(written.filter((l) => !read.includes(l)).sort()).toEqual([g.audioLabel, g.videoLabel].sort())
  })

  it('burns each clip its own captions, with its own fonts folder', () => {
    const g = buildBestOfGraph(
      [bestClip(), bestClip({ assFile: 'clip-1-work/captions.ass', fontsDir: 'clip-1-work/fonts' }), bestClip()],
      0.5
    )
    expect(g.graph.match(/ass=/g)).toHaveLength(1)
    expect(g.graph).toContain('[c1base]fps=30,ass=clip-1-work/captions.ass:fontsdir=clip-1-work/fonts,format=yuv420p,')
  })

  it('cuts each clip to a whole number of frames and shifts the crossfade with it', () => {
    const g = buildBestOfGraph([bestClip({ duration: 10.01 }), bestClip({ duration: 9.99 })], 0.5)
    // 10.01 s = 300.3 frames -> 300 frames = 10 s; 9.99 s = 299.7 frames -> 300 frames.
    expect(g.graph).toContain('trim=end_frame=300')
    expect(g.graph).not.toContain('trim=end_frame=301')
    expect(g.graph).toContain('offset=9.500')
    expect(g.inputArgs).toContain('10.010')
  })

  it('fills in silence for a clip with no audio, without using up an input', () => {
    const g = buildBestOfGraph([bestClip(), bestClip({ audioFile: null }), bestClip({ audioFile: 'clip-2.wav' })], 0.5)
    expect(g.graph).toContain('anullsrc=r=48000:cl=stereo,atrim=0:10.000000,asetpts=PTS-STARTPTS[a1]')
    // Inputs: video 0, wav 1, video 2, video 3, wav 4.
    expect(g.inputArgs.filter((a) => a === '-i')).toHaveLength(5)
    expect(g.graph).toContain('[3:v]')
    expect(g.graph).toContain('[4:a]')
    expect(g.graph).toContain('[ax1][a2]acrossfade')
  })

  it('has no audio graph at all when no clip has sound', () => {
    const g = buildBestOfGraph([bestClip({ audioFile: null }), bestClip({ audioFile: null })], 0.5)
    expect(g.audioLabel).toBeNull()
    expect(g.graph).not.toContain('anullsrc')
    expect(g.graph).not.toContain('acrossfade')
    expect(g.graph).not.toContain('[a0]')
  })

  it('handles many clips and keeps the offsets running', () => {
    const clips = Array.from({ length: 20 }, (_, i) => bestClip({ input: `clips/${i}.mp4`, audioFile: `clip-${i}.wav` }))
    const g = buildBestOfGraph(clips, 0.5)
    expect(g.graph.match(/xfade=/g)).toHaveLength(19)
    expect(g.graph.match(/acrossfade=/g)).toHaveLength(19)
    expect(g.graph).toContain('[v0][v1]xfade=transition=fade:duration=0.500:offset=9.500[vx1]')
    expect(g.graph).toContain('[vx18][v19]xfade=transition=fade:duration=0.500:offset=180.500[vx19]')
    expect(g.plan.totalDurationSec).toBeCloseTo(20 * 10 - 19 * 0.5, 5)
    expect(g.inputArgs.filter((a) => a === '-i')).toHaveLength(40)
  })
})

describe('buildBestOfRender', () => {
  it('reads the graph from a file, maps both outputs and encodes once', () => {
    const r = render([bestClip(), bestClip({ audioFile: 'clip-1.wav' })])
    expect(r.args.slice(0, 3)).toEqual(['-hide_banner', '-nostdin', '-y'])
    expect(r.args[r.args.indexOf('-/filter_complex') + 1]).toBe('graph.txt')
    expect(r.args).not.toContain('-filter_complex')
    expect(r.args).toContain('[vx1]')
    expect(r.args).toContain('[ax1]')
    expect(r.args.filter((a) => a === '-c:v')).toHaveLength(1)
    expect(r.args[r.args.length - 1]).toBe('out.mp4')
    expect(r.args.join(' ')).toContain('-c:a aac -b:a 192k -ar 48000')
    expect(r.args.join(' ')).toContain('-c:v libx264 -preset veryfast -crf 20 -profile:v high -g 60 -pix_fmt yuv420p')
    expect(r.args.join(' ')).toContain('-progress pipe:1')
    // The graph is not on the command line, however many clips there are.
    expect(r.args.join(' ')).not.toContain('xfade')
    expect(r.plan.totalDurationSec).toBeCloseTo(19.5, 5)
  })

  it('uses the chosen encoder', () => {
    expect(render([bestClip()], { encoder: 'h264_nvenc' }).args).toContain('h264_nvenc')
    expect(render([bestClip()], { encoder: 'h264_amf' }).args).toContain('h264_amf')
  })

  it('drops audio entirely when no clip has any', () => {
    const r = render([bestClip({ audioFile: null })])
    expect(r.args).toContain('-an')
    expect(r.args).not.toContain('-c:a')
  })

  it('keeps a long best-of far below the Windows command-line limit', () => {
    const clips = Array.from({ length: 50 }, (_, i) => bestClip({ input: `../../clips/${'0123456789abcdef'.repeat(2)}-${i}.mp4`, audioFile: `clip-${i}.wav` }))
    expect(render(clips).args.join(' ').length).toBeLessThan(30_000)
  })
})

describe('buildClipAudioArgs', () => {
  const src = (audio: AudioPlan, over: Partial<BestOfAudioSource> = {}): BestOfAudioSource => ({ input: 'C:\\clips\\a.mp4', seek: 2, duration: 10, audio, loudness: null, ...over })
  const stems: AudioPlan = { kind: 'stems', voice: 'v.wav', game: 'g.wav', gameGain: 0.3, music: 'm.mp3', musicGain: 0.22 }
  const filterOf = (args: string[]): string => args[args.indexOf('-filter_complex') + 1]!

  it('has nothing to render for a silent clip', () => {
    expect(buildClipAudioArgs(src({ kind: 'silent' }), 'clip-0.wav')).toBeNull()
  })

  it('runs the original audio through the same chain a normal export uses, into a float WAV', () => {
    const measured = { inputI: -20, inputTp: -3, inputLra: 5, inputThresh: -30, targetOffset: 0.5 }
    const args = buildClipAudioArgs(src({ kind: 'original' }, { loudness: measured }), 'clip-0.wav')!
    expect(args.slice(0, 9)).toEqual(['-hide_banner', '-nostdin', '-y', '-ss', '2.000', '-t', '10.000', '-i', 'C:\\clips\\a.mp4'])
    const normal = audioChain({ audio: { kind: 'original' }, loudness: measured, duration: 10 }, { mainInput: 0, firstExtraInput: 1, outLabel: 'aout' })
    expect(filterOf(args)).toBe(normal.filter)
    expect(args.slice(-9)).toEqual(['-map', '[aout]', '-c:a', 'pcm_f32le', '-ar', '48000', '-t', '10.000', 'clip-0.wav'])
  })

  it('mixes voice, quieter game and ducked music from the stems, without opening the source video', () => {
    const args = buildClipAudioArgs(src(stems), 'clip-0.wav')!
    expect(args).not.toContain('C:\\clips\\a.mp4')
    expect(args.slice(3, 11)).toEqual(['-i', 'v.wav', '-i', 'g.wav', '-stream_loop', '-1', '-i', 'm.mp3'])
    const f = filterOf(args)
    // Same chain as a normal export; the voice is input 0 here instead of 1.
    const normal = audioChain({ audio: stems, loudness: null, duration: 10 }, { mainInput: 0, firstExtraInput: 1, outLabel: 'aout' }).filter!
    expect(f).toBe(normal.replace('[1:a]', '[0:a]').replace('[2:a]', '[1:a]').replace('[3:a]', '[2:a]'))
    expect(f).toContain('amix=inputs=3')
    expect(f).toContain('sidechaincompress')
  })

  it('handles voice only', () => {
    const args = buildClipAudioArgs(src({ kind: 'stems', voice: 'v.wav', game: null, gameGain: 0, music: null, musicGain: 0 }), 'clip-0.wav')!
    expect(filterOf(args)).toBe('[0:a]aresample=48000,aformat=channel_layouts=stereo[voice];[voice]loudnorm=I=-14:TP=-1.5:LRA=11[aout]')
  })
})
