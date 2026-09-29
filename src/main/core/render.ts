// Builds FFmpeg argument arrays for exporting one clip. Pure: no I/O, no
// processes. The result is passed to execFile/spawn as an array (never a shell).

import type { Layout } from '@shared/types'
import { fitAspect, OUTPUT_SIZE, toPixels, verticalGeometry, type PixelRect, type RenderFormat, type Size } from '@shared/layoutGeometry'

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
 * input, so the input pad is a parameter.
 */
export function layoutBaseFilter(inputPad: string, format: RenderFormat, layout: Layout, source: Size, out: Size = OUTPUT_SIZE[format]): string[] {
  const parts: string[] = []

  if (format === 'horizontal') {
    const game = fitAspect(toPixels(layout.game, source), out.width / out.height, source)
    parts.push(`[${inputPad}]${crop(game)},scale=${out.width}:${out.height}:flags=lanczos,setsar=1[base]`)
  } else if (layout.kind === 'blur_fill') {
    const game = toPixels(layout.game, source)
    // Blur at a quarter of the size (a sigma of 24 at full size is 6 here) and
    // scale the result back up: far fewer pixels for gblur to touch.
    const bg = { width: evenPx(out.width / BLUR_DOWNSCALE), height: evenPx(out.height / BLUR_DOWNSCALE) }
    const sigma = Math.max(1, (24 / BLUR_DOWNSCALE) * (out.width / OUTPUT_SIZE.vertical.width))
    parts.push(`[${inputPad}]${crop(game)},split=2[bgsrc][fgsrc]`)
    parts.push(
      `[bgsrc]scale=${bg.width}:${bg.height}:force_original_aspect_ratio=increase:flags=bilinear,crop=${bg.width}:${bg.height},gblur=sigma=${Number(sigma.toFixed(2))},eq=brightness=-0.06,scale=${out.width}:${out.height}:flags=bilinear[bg]`
    )
    parts.push(`[fgsrc]scale=${out.width}:-2:flags=lanczos[fg]`)
    parts.push(`[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[base]`)
  } else {
    const g = verticalGeometry(layout, source)
    if (g.cam) {
      // The geometry is worked out for the full-size frame; a smaller output keeps its proportions.
      const camHeight = out.height === OUTPUT_SIZE.vertical.height ? g.camHeight : evenPx((g.camHeight * out.height) / OUTPUT_SIZE.vertical.height)
      const gameHeight = out.height - camHeight
      parts.push(`[${inputPad}]split=2[camsrc][gamesrc]`)
      parts.push(`[camsrc]${crop(g.cam)},scale=${out.width}:${camHeight}:flags=lanczos,setsar=1[cam]`)
      parts.push(`[gamesrc]${crop(g.game)},scale=${out.width}:${gameHeight}:flags=lanczos,setsar=1[game]`)
      parts.push('[cam][game]vstack=inputs=2[base]')
    } else {
      parts.push(`[${inputPad}]${crop(g.game)},scale=${out.width}:${out.height}:flags=lanczos,setsar=1[base]`)
    }
  }
  return parts
}

/** The video part of the filter graph, ending in [vout]. */
export function videoFilter(spec: RenderSpec): string {
  const fps = clampFps(spec.sourceFps)
  const parts = layoutBaseFilter('0:v', spec.format, spec.layout, spec.source, spec.outputSize)

  let chain = '[base]fps=' + fps
  if (spec.assFile) {
    chain += `,ass=${filterValue(spec.assFile)}`
    if (spec.fontsDir) chain += `:fontsdir=${filterValue(spec.fontsDir)}`
  }
  chain += ',format=yuv420p[vout]'
  parts.push(chain)
  return parts.join(';')
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

/** The audio part of the filter graph, ending in [aout], plus extra inputs. */
export function audioFilter(spec: RenderSpec): { inputs: string[][]; filter: string | null } {
  const a = spec.audio
  const norm = loudnormFilter(spec.loudness)
  const fmt = 'aresample=48000,aformat=channel_layouts=stereo'
  if (a.kind === 'silent') return { inputs: [], filter: null }
  if (a.kind === 'original') return { inputs: [], filter: `[0:a]${fmt},${norm}[aout]` }

  const inputs: string[][] = [['-i', a.voice]]
  const parts: string[] = [`[1:a]${fmt}[voice]`]
  const mix = ['[voice]']
  let next = 2
  if (a.game) {
    inputs.push(['-i', a.game])
    parts.push(`[${next}:a]${fmt},volume=${a.gameGain.toFixed(3)}[game]`)
    mix.push('[game]')
    next++
  }
  if (a.music) {
    inputs.push(['-stream_loop', '-1', '-i', a.music])
    const fadeOut = Math.max(0, spec.duration - 1.5).toFixed(2)
    parts.push(
      `[${next}:a]${fmt},atrim=0:${spec.duration.toFixed(3)},volume=${a.musicGain.toFixed(3)},afade=t=in:d=1,afade=t=out:st=${fadeOut}:d=1.5[musicraw]`
    )
    // Duck the music under the voice.
    parts[0] = `[1:a]${fmt},asplit=2[voice][voicekey]`
    parts.push('[musicraw][voicekey]sidechaincompress=threshold=0.04:ratio=6:attack=20:release=400[music]')
    mix.push('[music]')
  }
  if (mix.length === 1) parts.push(`[voice]${norm}[aout]`)
  else parts.push(`${mix.join('')}amix=inputs=${mix.length}:duration=first:normalize=0,${norm}[aout]`)
  return { inputs, filter: parts.join(';') }
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
