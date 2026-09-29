// Builds FFmpeg argument arrays for exporting one clip. Pure: no I/O, no
// processes. The result is passed to execFile/spawn as an array (never a shell).

import type { Layout } from '@shared/types'
import { fitAspect, layoutPlan, OUTPUT_SIZE, stackHeights, toPixels, verticalGeometry, type PixelRect, type RenderFormat, type Size } from '@shared/layoutGeometry'

export { fitAspect, OUTPUT_SIZE, toPixels, verticalGeometry, type PixelRect, type RenderFormat, type Size }

export type EncoderId = 'h264_nvenc' | 'h264_amf' | 'h264_qsv' | 'libx264'

/** Loudness measured by a first loudnorm pass, for an exact second pass. */
export interface LoudnessMeasurement {
  inputI: number
  inputTp: number
  inputLra: number
  inputThresh: number
  targetOffset: number
}

export type AudioPlan =
  | { kind: 'original' }
  | { kind: 'silent' }
  | {
      kind: 'stems'
      /** Clip-length voice stem (starts at the clip start). */
      voice: string
      /** Clip-length game/background stem, when it should be kept. */
      game: string | null
      gameGain: number
      /** Music file, looped and trimmed; ducked under the voice. */
      music: string | null
      musicGain: number
    }

export interface RenderSpec {
  input: string
  /** Seconds into the input where the clip starts. */
  seek: number
  duration: number
  source: Size
  sourceFps: number
  format: RenderFormat
  layout: Layout
  /** ASS file name relative to the FFmpeg working directory, or null. */
  assFile: string | null
  /** Fonts directory relative to the working directory. */
  fontsDir: string | null
  audio: AudioPlan
  loudness: LoudnessMeasurement | null
  encoder: EncoderId
  output: string
  /** Output frame size; the format's full size when omitted (a small preview passes its own). */
  outputSize?: Size
}

export const crop = (r: PixelRect): string => `crop=${r.w}:${r.h}:${r.x}:${r.y}`

/** Frame rate every render targets: Twitch VODs are usually 60 or 30 fps. */
export function clampFps(sourceFps: number): number {
  return Math.min(60, Math.max(24, Math.round(sourceFps || 30)))
}

const evenPx = (n: number): number => Math.max(2, Math.round(n / 2) * 2)

/** The blurred background is drawn at this fraction of the output size and scaled back up; the blur hides the lost detail. */
const BLUR_DOWNSCALE = 4

/**
 * The layout part of the video graph: crops and composes the source frame
 * (facecam over game, blurred fill, or a plain crop) into `out.width x
 * out.height` (the format's full size unless a smaller `out` is given, for a
 * throwaway preview), ending in a pad named `base`. Shared with
 * `core/edlFilter.ts`, which runs it on a re-timed stream instead of the raw
 * input, so the input pad is a parameter. `prefix` goes in front of every pad
 * name, so several clips can live in one filter graph (the best-of join).
 */
export function layoutBaseFilter(inputPad: string, format: RenderFormat, layout: Layout, source: Size, out: Size = OUTPUT_SIZE[format], prefix = ''): string[] {
  const parts: string[] = []
  const pad = (name: string): string => `[${prefix}${name}]`

  const plan = layoutPlan(layout, format, source)
  if (plan.mode === 'crop') {
    parts.push(`[${inputPad}]${crop(plan.src)},scale=${out.width}:${out.height}:flags=lanczos,setsar=1${pad('base')}`)
  } else if (plan.mode === 'blur') {
    // Blur at a quarter of the size (a sigma of 24 at full size is 6 here) and
    // scale the result back up: far fewer pixels for gblur to touch.
    const bg = { width: evenPx(out.width / BLUR_DOWNSCALE), height: evenPx(out.height / BLUR_DOWNSCALE) }
    const sigma = Math.max(1, (24 / BLUR_DOWNSCALE) * (out.width / OUTPUT_SIZE.vertical.width))
    parts.push(`[${inputPad}]${crop(plan.src)},split=2${pad('bgsrc')}${pad('fgsrc')}`)
    parts.push(
      `${pad('bgsrc')}scale=${bg.width}:${bg.height}:force_original_aspect_ratio=increase:flags=bilinear,crop=${bg.width}:${bg.height},gblur=sigma=${Number(sigma.toFixed(2))},eq=brightness=-0.06,scale=${out.width}:${out.height}:flags=bilinear${pad('bg')}`
    )
    parts.push(`${pad('fgsrc')}scale=${out.width}:-2:flags=lanczos${pad('fg')}`)
    parts.push(`${pad('bg')}${pad('fg')}overlay=(W-w)/2:(H-h)/2,setsar=1${pad('base')}`)
  } else {
    // The geometry is worked out for the full-size frame; a smaller output keeps its proportions.
    const { camHeight, gameHeight } = stackHeights(plan.camHeight, out)
    parts.push(`[${inputPad}]split=2${pad('camsrc')}${pad('gamesrc')}`)
    parts.push(`${pad('camsrc')}${crop(plan.cam)},scale=${out.width}:${camHeight}:flags=lanczos,setsar=1${pad('cam')}`)
    parts.push(`${pad('gamesrc')}${crop(plan.game)},scale=${out.width}:${gameHeight}:flags=lanczos,setsar=1${pad('game')}`)
    parts.push(`${pad('cam')}${pad('game')}vstack=inputs=2${pad('base')}`)
  }
  return parts
}

/** The parts of a `RenderSpec` the video chain reads. */
export type VideoSpec = Pick<RenderSpec, 'format' | 'layout' | 'source' | 'sourceFps' | 'assFile' | 'fontsDir' | 'outputSize'>
/** The parts of a `RenderSpec` the audio chain reads. */
export type AudioSpec = Pick<RenderSpec, 'audio' | 'loudness' | 'duration'>

export interface VideoChainOptions {
  /** Pad the layout reads from, e.g. `0:v`. */
  inputPad: string
  /** Goes in front of every internal pad name, so several clips fit in one graph. */
  prefix?: string
  /** Name of the finished pad (without brackets). */
  outLabel: string
  /** Output frame rate; the source's, clamped to 24-60, when omitted. */
  fps?: number
  /** Extra filters (each starting with a comma) run after the pixel format, before the finished pad. */
  tail?: string
}

/** One clip's video chain as labelled pieces: layout, frame rate, captions, pixel format. */
export function videoChain(spec: VideoSpec, o: VideoChainOptions): string[] {
  const fps = o.fps ?? clampFps(spec.sourceFps)
  const prefix = o.prefix ?? ''
  const parts = layoutBaseFilter(o.inputPad, spec.format, spec.layout, spec.source, spec.outputSize, prefix)

  let chain = `[${prefix}base]fps=` + fps
  if (spec.assFile) {
    chain += `,ass=${filterValue(spec.assFile)}`
    if (spec.fontsDir) chain += `:fontsdir=${filterValue(spec.fontsDir)}`
  }
  chain += `,format=yuv420p${o.tail ?? ''}[${o.outLabel}]`
  parts.push(chain)
  return parts
}

/** The video part of the filter graph, ending in [vout]. */
export function videoFilter(spec: RenderSpec): string {
  return videoChain(spec, { inputPad: '0:v', outLabel: 'vout' }).join(';')
}

/**
 * Escapes a value for use inside a filter graph option. Callers pass simple
 * relative names; this is a second line of defence.
 */
export function filterValue(v: string): string {
  if (/^[A-Za-z0-9._/-]+$/.test(v)) return v
  return `'${v.replace(/\\/g, '/').replace(/'/g, "'\\''").replace(/:/g, '\\:')}'`
}

export function loudnormFilter(m: LoudnessMeasurement | null): string {
  const base = 'loudnorm=I=-14:TP=-1.5:LRA=11'
  if (!m) return base
  return `${base}:measured_I=${m.inputI}:measured_TP=${m.inputTp}:measured_LRA=${m.inputLra}:measured_thresh=${m.inputThresh}:offset=${m.targetOffset}:linear=true`
}

export interface AudioChainOptions {
  /** Index of the `-i` input the original audio is read from. */
  mainInput: number
  /** Index the first extra input (voice stem) gets; game and music follow it. */
  firstExtraInput: number
  /** Goes in front of every internal pad name, so several clips fit in one graph. */
  prefix?: string
  /** Name of the finished pad (without brackets). */
  outLabel: string
  /** Extra filters (each starting with a comma) run after the loudness step, before the finished pad. */
  tail?: string
}

/** One clip's audio chain: the filter (null for a silent clip) and the extra `-i` inputs it reads, numbered from `firstExtraInput`. */
export function audioChain(spec: AudioSpec, o: AudioChainOptions): { inputs: string[][]; filter: string | null } {
  const a = spec.audio
  const norm = loudnormFilter(spec.loudness)
  const fmt = 'aresample=48000,aformat=channel_layouts=stereo'
  const prefix = o.prefix ?? ''
  const pad = (name: string): string => `[${prefix}${name}]`
  const out = `${o.tail ?? ''}[${o.outLabel}]`
  if (a.kind === 'silent') return { inputs: [], filter: null }
  if (a.kind === 'original') return { inputs: [], filter: `[${o.mainInput}:a]${fmt},${norm}${out}` }

  const inputs: string[][] = [['-i', a.voice]]
  const parts: string[] = [`[${o.firstExtraInput}:a]${fmt}${pad('voice')}`]
  const mix = [pad('voice')]
  let next = o.firstExtraInput + 1
  if (a.game) {
    inputs.push(['-i', a.game])
    parts.push(`[${next}:a]${fmt},volume=${a.gameGain.toFixed(3)}${pad('game')}`)
    mix.push(pad('game'))
    next++
  }
  if (a.music) {
    inputs.push(['-stream_loop', '-1', '-i', a.music])
    const fadeOut = Math.max(0, spec.duration - 1.5).toFixed(2)
    parts.push(
      `[${next}:a]${fmt},atrim=0:${spec.duration.toFixed(3)},volume=${a.musicGain.toFixed(3)},afade=t=in:d=1,afade=t=out:st=${fadeOut}:d=1.5${pad('musicraw')}`
    )
    // Duck the music under the voice.
    parts[0] = `[${o.firstExtraInput}:a]${fmt},asplit=2${pad('voice')}${pad('voicekey')}`
    parts.push(`${pad('musicraw')}${pad('voicekey')}sidechaincompress=threshold=0.04:ratio=6:attack=20:release=400${pad('music')}`)
    mix.push(pad('music'))
  }
  if (mix.length === 1) parts.push(`${pad('voice')}${norm}${out}`)
  else parts.push(`${mix.join('')}amix=inputs=${mix.length}:duration=first:normalize=0,${norm}${out}`)
  return { inputs, filter: parts.join(';') }
}

/** The audio part of the filter graph, ending in [aout], plus extra inputs. */
export function audioFilter(spec: RenderSpec): { inputs: string[][]; filter: string | null } {
  return audioChain(spec, { mainInput: 0, firstExtraInput: 1, outLabel: 'aout' })
}

/** Encoder settings tuned for 1080p social uploads. */
export function encoderArgs(encoder: EncoderId, fps: number): string[] {
  const gop = String(Math.round(fps * 2))
  switch (encoder) {
    case 'h264_nvenc':
      return ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', '21', '-b:v', '0', '-maxrate', '16M', '-bufsize', '32M', '-profile:v', 'high', '-spatial-aq', '1', '-g', gop]
    case 'h264_amf':
      return ['-c:v', 'h264_amf', '-usage', 'transcoding', '-quality', 'quality', '-rc', 'vbr_peak', '-b:v', '12M', '-maxrate', '16M', '-bufsize', '24M', '-profile:v', 'high', '-g', gop]
    case 'h264_qsv':
      return ['-c:v', 'h264_qsv', '-preset', 'slow', '-global_quality', '22', '-profile:v', 'high', '-g', gop]
    case 'libx264':
      return ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '20', '-profile:v', 'high', '-g', gop]
  }
}

/** Full FFmpeg argument list for one clip export. */
export function buildRenderArgs(spec: RenderSpec): string[] {
  const fps = clampFps(spec.sourceFps)
  const audio = audioFilter(spec)
  const graph = [videoFilter(spec), audio.filter].filter(Boolean).join(';')
  const args = [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-ss',
    spec.seek.toFixed(3),
    '-t',
    spec.duration.toFixed(3),
    '-i',
    spec.input,
    ...audio.inputs.flat(),
    '-filter_complex',
    graph,
    '-map',
    '[vout]'
  ]
  if (audio.filter) args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-ar', '48000')
  else args.push('-an')
  args.push(
    ...encoderArgs(spec.encoder, fps),
    '-pix_fmt',
    'yuv420p',
    '-t',
    spec.duration.toFixed(3),
    '-movflags',
    '+faststart',
    '-progress',
    'pipe:1',
    '-nostats',
    spec.output
  )
  return args
}

/** Arguments for the first loudnorm pass (measure only). */
export function buildLoudnessMeasureArgs(input: string, seek: number, duration: number): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-ss',
    seek.toFixed(3),
    '-t',
    duration.toFixed(3),
    '-i',
    input,
    '-vn',
    '-af',
    'loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json',
    '-f',
    'null',
    '-'
  ]
}

/** Reads the JSON block loudnorm prints at the end of a measure pass. */
export function parseLoudnessMeasure(stderr: string): LoudnessMeasurement | null {
  const start = stderr.lastIndexOf('{')
  const end = stderr.lastIndexOf('}')
  if (start < 0 || end < start) return null
  try {
    const j = JSON.parse(stderr.slice(start, end + 1)) as Record<string, string>
    const m = {
      inputI: Number(j.input_i),
      inputTp: Number(j.input_tp),
      inputLra: Number(j.input_lra),
      inputThresh: Number(j.input_thresh),
      targetOffset: Number(j.target_offset)
    }
    // Silent clips measure as -inf; fall back to single-pass normalisation.
    return Object.values(m).every(Number.isFinite) ? m : null
  } catch {
    return null
  }
}

/** Reads `-progress pipe:1` output; returns seconds encoded so far, if present. */
export function parseProgressSeconds(chunk: string): number | null {
  let last: number | null = null
  for (const m of chunk.matchAll(/out_time_(?:us|ms)=(\d+)/g)) last = Number(m[1]) / 1e6
  return last
}
