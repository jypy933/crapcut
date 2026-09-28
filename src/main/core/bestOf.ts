// Builds the FFmpeg argument array that joins several already-rendered 16:9
// clips into one video with short crossfades. Pure: no I/O, no processes.
// Each input is normalised (size, frame rate, sample rate, pixel format) so
// clips that came from different sources still line up cleanly.

import { OUTPUT_SIZE } from '@shared/layoutGeometry'
import type { Clip } from '@shared/types'
import { encoderArgs, type EncoderId } from './render'

/** The join always targets this frame rate and audio format, whatever the inputs used. */
export const BEST_OF_FPS = 30
export const BEST_OF_SAMPLE_RATE = 48000
/** Good default: long enough to feel like a transition, short enough to stay snappy. */
export const DEFAULT_CROSSFADE_SEC = 0.5
/** A crossfade never eats more than this share of either neighbouring clip. */
const MAX_CROSSFADE_SHARE = 0.4
const MIN_CROSSFADE_SEC = 0.05

/**
 * Which clips go into the best-of, and in what order: kept clips only, in
 * stream order (by start time). `clip.rank` is strength order (the finder's
 * favourite moment first) -- it must never be used to order the join, or the
 * video would jump around the stream instead of playing through it.
 */
export function keptClipsInOrder(clips: readonly Clip[]): Clip[] {
  return clips.filter((c) => c.status === 'accepted').sort((a, b) => a.start - b.start)
}

export interface BestOfClipInput {
  /** Path passed to `-i`, resolved relative to the FFmpeg working directory. */
  file: string
  duration: number
  hasAudio: boolean
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

function normaliseVideo(i: number): string {
  const { width, height } = OUTPUT_SIZE.horizontal
  return (
    `[${i}:v]scale=${width}:${height}:force_original_aspect_ratio=decrease,` +
    `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1,fps=${BEST_OF_FPS},format=yuv420p[v${i}]`
  )
}

function normaliseAudio(i: number, clip: BestOfClipInput): string {
  if (clip.hasAudio) return `[${i}:a]aresample=${BEST_OF_SAMPLE_RATE},aformat=sample_fmts=fltp:channel_layouts=stereo[a${i}]`
  // A clip with no audio track (e.g. a silent source) gets silence of its own
  // length, so the timeline stays continuous once other clips have sound.
  return `anullsrc=r=${BEST_OF_SAMPLE_RATE}:cl=stereo,atrim=0:${clip.duration.toFixed(3)},asetpts=PTS-STARTPTS[a${i}]`
}

export interface BestOfArgsOptions {
  crossfadeSec: number
  encoder: EncoderId
  /** Output path, relative to the FFmpeg working directory like the inputs. */
  output: string
}

/** Full FFmpeg argument list to join the clips. A single clip is just re-encoded (no crossfade). */
export function buildBestOfArgs(clips: readonly BestOfClipInput[], opts: BestOfArgsOptions): string[] {
  if (clips.length === 0) throw new Error('buildBestOfArgs needs at least one clip')
  const plan = planBestOfJoin(clips, opts.crossfadeSec)
  const anyAudio = clips.some((c) => c.hasAudio)

  const parts: string[] = []
  for (let i = 0; i < clips.length; i++) {
    parts.push(normaliseVideo(i))
    if (anyAudio) parts.push(normaliseAudio(i, clips[i]!))
  }

  let vlabel = 'v0'
  let alabel = 'a0'
  for (let i = 1; i < clips.length; i++) {
    const t = plan.transitions[i - 1]!
    const vout = `vx${i}`
    parts.push(`[${vlabel}][v${i}]xfade=transition=fade:duration=${Math.max(MIN_CROSSFADE_SEC, t.crossfadeSec).toFixed(3)}:offset=${t.offsetSec.toFixed(3)}[${vout}]`)
    vlabel = vout
    if (anyAudio) {
      const aout = `ax${i}`
      parts.push(`[${alabel}][a${i}]acrossfade=d=${Math.max(MIN_CROSSFADE_SEC, t.crossfadeSec).toFixed(3)}[${aout}]`)
      alabel = aout
    }
  }

  const args = ['-hide_banner', '-nostdin', '-y']
  for (const c of clips) args.push('-i', c.file)
  args.push('-filter_complex', parts.join(';'), '-map', `[${vlabel}]`)
  if (anyAudio) args.push('-map', `[${alabel}]`, '-c:a', 'aac', '-b:a', '192k', '-ar', String(BEST_OF_SAMPLE_RATE))
  else args.push('-an')
  args.push(...encoderArgs(opts.encoder, BEST_OF_FPS), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', opts.output)
  return args
}
