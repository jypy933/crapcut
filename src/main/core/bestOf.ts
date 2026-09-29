// Builds the FFmpeg commands that turn a job's kept clips into one video with
// short crossfades, with a single video encode. Pure: no I/O, no processes.
//
// Each clip's sound is first rendered to a lossless float WAV with the same
// audio chain a normal 16:9 export uses (`buildClipAudioArgs`). Then one filter
// graph takes every clip as its own labelled branch (its cut of the source, the
// same 16:9 layout and captions a normal export has, its WAV), normalises them
// to one size, frame rate and audio format, and chains them through
// xfade/acrossfade into one encode. Nothing lossy happens before that last
// step, so the clips are never compressed twice.

import type { Clip, Layout } from '@shared/types'
import { audioChain, encoderArgs, videoChain, type AudioPlan, type EncoderId, type LoudnessMeasurement, type Size } from './render'

/** The join always targets this frame rate and audio format, whatever the sources used. */
export const BEST_OF_FPS = 30
export const BEST_OF_SAMPLE_RATE = 48000
/** Good default: long enough to feel like a transition, short enough to stay snappy. */
export const DEFAULT_CROSSFADE_SEC = 0.5
/** A crossfade never eats more than this share of either neighbouring clip. */
const MAX_CROSSFADE_SHARE = 0.4
const MIN_CROSSFADE_SEC = 0.05
/**
 * Every clip keeps its own decoder open for the whole encode (about 60-90 MB
 * each at 1080p), so one graph only takes this many; more would not fit in
 * the memory of a typical PC.
 */
export const MAX_BEST_OF_CLIPS = 50

/**
 * Which clips go into the best-of, and in what order: kept clips only, in
 * stream order (by start time). `clip.rank` is strength order (the finder's
 * favourite moment first) -- it must never be used to order the join, or the
 * video would jump around the stream instead of playing through it.
 */
export function keptClipsInOrder(clips: readonly Clip[]): Clip[] {
  return clips.filter((c) => c.status === 'accepted').sort((a, b) => a.start - b.start)
}

/** What the plan needs to know about one clip: its length on the joined timeline. */
export interface BestOfClipInput {
  duration: number
}

export interface BestOfTransition {
  /** Crossfade duration actually used for this transition, clamped to fit both clips. */
  crossfadeSec: number
  /** Seconds into the joined-so-far stream where this transition starts. */
  offsetSec: number
}

export interface BestOfPlan {
  transitions: BestOfTransition[]
  /** Total duration of the joined output, in seconds. */
  totalDurationSec: number
}

/**
 * Works out how long each transition can be and where it falls, without
 * building any FFmpeg arguments. A transition is clamped so it never runs
 * longer than 40% of either clip it joins -- a short clip gets a short
 * crossfade instead of the whole thing dissolving away.
 */
export function planBestOfJoin(clips: readonly BestOfClipInput[], crossfadeSec: number): BestOfPlan {
  if (clips.length === 0) return { transitions: [], totalDurationSec: 0 }
  let joined = Math.max(0, clips[0]!.duration)
  const transitions: BestOfTransition[] = []
  for (let i = 1; i < clips.length; i++) {
    const next = Math.max(0, clips[i]!.duration)
    const cap = Math.min(crossfadeSec, joined * MAX_CROSSFADE_SHARE, next * MAX_CROSSFADE_SHARE)
    const cf = Math.max(MIN_CROSSFADE_SEC, Math.min(crossfadeSec, cap))
    // If even the floor does not fit (a very short clip), fall back to a hard cut.
    const used = cf <= joined && cf <= next ? cf : 0
    transitions.push({ crossfadeSec: used, offsetSec: joined - used })
    joined = joined + next - used
  }
  return { transitions, totalDurationSec: joined }
}

/** A clip's length on the joined timeline: a whole number of frames, so video and audio end together. */
export function clipLengthSec(duration: number): number {
  return Math.max(1, Math.round(duration * BEST_OF_FPS)) / BEST_OF_FPS
}

/** What one clip's sound is made from; the same plan a normal export of the clip would use. */
export interface BestOfAudioSource {
  /** Source video file, for the original audio. */
  input: string
  seek: number
  duration: number
  audio: AudioPlan
  loudness: LoudnessMeasurement | null
}

/**
 * Arguments that render one clip's sound to a float WAV, through the exact
 * audio chain of a normal export (loudness, voice/game/music mix). Null for a
 * clip without sound. The WAV is lossless, so the join can read it back and
 * the only lossy audio encode is the final one.
 */
export function buildClipAudioArgs(src: BestOfAudioSource, output: string): string[] | null {
  if (src.audio.kind === 'silent') return null
  const original = src.audio.kind === 'original'
  // The stems are their own inputs, so the source video is only opened for the original audio.
  const chain = audioChain(src, { mainInput: 0, firstExtraInput: original ? 1 : 0, outLabel: 'aout' })
  const args = ['-hide_banner', '-nostdin', '-y']
  if (original) args.push('-ss', src.seek.toFixed(3), '-t', src.duration.toFixed(3), '-i', src.input)
  args.push(...chain.inputs.flat(), '-filter_complex', chain.filter!, '-map', '[aout]', '-c:a', 'pcm_f32le', '-ar', String(BEST_OF_SAMPLE_RATE), '-t', src.duration.toFixed(3), output)
  return args
}

/** One kept clip, prepared: where its picture and sound come from and how it looks. */
export interface BestOfClip {
  /** Source video file (path passed to `-i`). */
  input: string
  /** Seconds into `input` where the clip starts. */
  seek: number
  /** Clip length in seconds, before rounding to whole frames. */
  duration: number
  /** Size of the source picture. */
  source: Size
  layout: Layout
  /** ASS file with the clip's captions (and chat overlay), relative to the FFmpeg working directory, or null. */
  assFile: string | null
  /** Fonts directory relative to the working directory. */
  fontsDir: string | null
  /** The clip's finished sound from `buildClipAudioArgs`, or null when the source has none. */
  audioFile: string | null
}

export interface BestOfGraph {
  /** Every `-ss`/`-t`/`-i` argument, clip by clip. */
  inputArgs: string[]
  /** The whole filter graph, ready to be written to a script file. */
  graph: string
  videoLabel: string
  /** Null when no clip has any sound. */
  audioLabel: string | null
  plan: BestOfPlan
}

/** Pure graph for the whole best-of: inputs, per-clip branches, crossfade chain. */
export function buildBestOfGraph(clips: readonly BestOfClip[], crossfadeSec: number): BestOfGraph {
  if (clips.length === 0) throw new Error('buildBestOfGraph needs at least one clip')
  const lengths = clips.map((c) => clipLengthSec(c.duration))
  const plan = planBestOfJoin(
    lengths.map((duration) => ({ duration })),
    crossfadeSec
  )
  const anyAudio = clips.some((c) => c.audioFile)

  const inputArgs: string[] = []
  const parts: string[] = []
  let inputCount = 0
  for (let i = 0; i < clips.length; i++) {
    const c = clips[i]!
    const len = lengths[i]!.toFixed(6)
    const frames = Math.round(lengths[i]! * BEST_OF_FPS)

    inputArgs.push('-ss', c.seek.toFixed(3), '-t', c.duration.toFixed(3), '-i', c.input)
    // The picture is padded with its last frame and cut to a whole frame count,
    // so a source that ends a hair early still lines up with the crossfade.
    parts.push(
      ...videoChain(
        { format: 'horizontal', layout: c.layout, source: c.source, sourceFps: BEST_OF_FPS, assFile: c.assFile, fontsDir: c.fontsDir },
        {
          inputPad: `${inputCount++}:v`,
          prefix: `c${i}`,
          outLabel: `v${i}`,
          fps: BEST_OF_FPS,
          tail: `,tpad=stop_mode=clone:stop=-1,trim=end_frame=${frames},setpts=PTS-STARTPTS`
        }
      )
    )

    if (!anyAudio) continue
    if (c.audioFile) {
      inputArgs.push('-i', c.audioFile)
      parts.push(
        `[${inputCount++}:a]aresample=${BEST_OF_SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo,apad=whole_dur=${len},atrim=end=${len},asetpts=PTS-STARTPTS[a${i}]`
      )
    } else {
      // A clip with no audio track gets silence of its own length, so the
      // timeline stays continuous once other clips have sound.
      parts.push(`anullsrc=r=${BEST_OF_SAMPLE_RATE}:cl=stereo,atrim=0:${len},asetpts=PTS-STARTPTS[a${i}]`)
    }
  }

  let vlabel = 'v0'
  let alabel = 'a0'
  for (let i = 1; i < clips.length; i++) {
    const t = plan.transitions[i - 1]!
    const d = Math.max(MIN_CROSSFADE_SEC, t.crossfadeSec).toFixed(3)
    const vout = `vx${i}`
    parts.push(`[${vlabel}][v${i}]xfade=transition=fade:duration=${d}:offset=${t.offsetSec.toFixed(3)}[${vout}]`)
    vlabel = vout
    if (anyAudio) {
      const aout = `ax${i}`
      parts.push(`[${alabel}][a${i}]acrossfade=d=${d}[${aout}]`)
      alabel = aout
    }
  }

  return { inputArgs, graph: parts.join(';'), videoLabel: vlabel, audioLabel: anyAudio ? alabel : null, plan }
}

export interface BestOfArgsOptions {
  crossfadeSec: number
  encoder: EncoderId
  /** Where the filter graph is written; passed to FFmpeg with `-/filter_complex`. Relative to the FFmpeg working directory. */
  filterScript: string
  /** Output path, relative to the FFmpeg working directory. */
  output: string
}

/**
 * Full FFmpeg argument list for the best-of, plus the graph the caller must
 * write to `opts.filterScript` first (a long graph would overflow the Windows
 * command line). A single clip is just encoded once, with no crossfade.
 */
export function buildBestOfRender(clips: readonly BestOfClip[], opts: BestOfArgsOptions): { args: string[]; graph: string; plan: BestOfPlan } {
  const g = buildBestOfGraph(clips, opts.crossfadeSec)
  const args = ['-hide_banner', '-nostdin', '-y', ...g.inputArgs, '-/filter_complex', opts.filterScript, '-map', `[${g.videoLabel}]`]
  if (g.audioLabel) args.push('-map', `[${g.audioLabel}]`, '-c:a', 'aac', '-b:a', '192k', '-ar', String(BEST_OF_SAMPLE_RATE))
  else args.push('-an')
  args.push(...encoderArgs(opts.encoder, BEST_OF_FPS), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', opts.output)
  return { args, graph: g.graph, plan: g.plan }
}
