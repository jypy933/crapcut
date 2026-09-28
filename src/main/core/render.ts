// Builds FFmpeg argument arrays for exporting one clip. Pure: no I/O, no
// processes. The result is passed to execFile/spawn as an array (never a shell).

import type { Layout, Rect } from '@shared/types'

export type EncoderId = 'h264_nvenc' | 'h264_amf' | 'h264_qsv' | 'libx264'
export type RenderFormat = 'vertical' | 'horizontal'

export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
}

export interface Size {
  width: number
  height: number
}

export const OUTPUT_SIZE: Record<RenderFormat, Size> = {
  vertical: { width: 1080, height: 1920 },
  horizontal: { width: 1920, height: 1080 }
}

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
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/** Normalised rect → whole even pixels inside the frame. */
export function toPixels(r: Rect, size: Size): PixelRect {
  const x = clamp(r.x, 0, 1)
  const y = clamp(r.y, 0, 1)
  const w = clamp(r.w, 0.01, 1 - x)
  const h = clamp(r.h, 0.01, 1 - y)
  const px: PixelRect = { x: even(x * size.width), y: even(y * size.height), w: even(w * size.width), h: even(h * size.height) }
  px.w = Math.min(px.w, size.width - px.x)
  px.h = Math.min(px.h, size.height - px.y)
  if (px.w % 2) px.w -= 1
  if (px.h % 2) px.h -= 1
  return px
}

/** The largest rect of aspect `aspect` (w/h) inside `r`, centred on it. */
export function fitAspect(r: PixelRect, aspect: number, frame: Size): PixelRect {
  let w = r.w
  let h = r.h
  if (w / h > aspect) w = h * aspect
  else h = w / aspect
  w = Math.min(even(w), frame.width)
  h = Math.min(even(h), frame.height)
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const x = clamp(even(cx - w / 2), 0, frame.width - w)
  const y = clamp(even(cy - h / 2), 0, frame.height - h)
  return { x, y, w, h }
}

export interface VerticalGeometry {
  cam: PixelRect | null
  camHeight: number
  game: PixelRect
  gameHeight: number
}

/**
 * Cam + game: the facecam fills the top at full width (between a quarter and
 * 45% of the height), the game fills the rest.
 */
export function verticalGeometry(layout: Layout, source: Size): VerticalGeometry {
  const out = OUTPUT_SIZE.vertical
  const gameArea = toPixels(layout.game, source)
  if (layout.kind === 'cam_game' && layout.cam) {
    const camArea = toPixels(layout.cam, source)
    const natural = (out.width * camArea.h) / camArea.w
    const camHeight = even(clamp(natural, out.height * 0.25, out.height * 0.45))
    const gameHeight = out.height - camHeight
    return {
      cam: fitAspect(camArea, out.width / camHeight, source),
      camHeight,
      game: fitAspect(gameArea, out.width / gameHeight, source),
      gameHeight
    }
  }
  return { cam: null, camHeight: 0, game: fitAspect(gameArea, out.width / out.height, source), gameHeight: out.height }
}

const crop = (r: PixelRect): string => `crop=${r.w}:${r.h}:${r.x}:${r.y}`

/** The video part of the filter graph, ending in [vout]. */
export function videoFilter(spec: RenderSpec): string {
  const out = OUTPUT_SIZE[spec.format]
  const fps = Math.min(60, Math.max(24, Math.round(spec.sourceFps || 30)))
  const parts: string[] = []
  let last: string

  if (spec.format === 'horizontal') {
    const game = fitAspect(toPixels(spec.layout.game, spec.source), out.width / out.height, spec.source)
    parts.push(`[0:v]${crop(game)},scale=${out.width}:${out.height}:flags=lanczos,setsar=1[base]`)
    last = 'base'
  } else if (spec.layout.kind === 'blur_fill') {
    const game = toPixels(spec.layout.game, spec.source)
    parts.push(`[0:v]${crop(game)},split=2[bgsrc][fgsrc]`)
    parts.push(
      `[bgsrc]scale=${out.width}:${out.height}:force_original_aspect_ratio=increase,crop=${out.width}:${out.height},gblur=sigma=24,eq=brightness=-0.06[bg]`
    )
    parts.push(`[fgsrc]scale=${out.width}:-2:flags=lanczos[fg]`)
    parts.push(`[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1[base]`)
    last = 'base'
  } else {
    const g = verticalGeometry(spec.layout, spec.source)
    if (g.cam) {
      parts.push('[0:v]split=2[camsrc][gamesrc]')
      parts.push(`[camsrc]${crop(g.cam)},scale=${out.width}:${g.camHeight}:flags=lanczos,setsar=1[cam]`)
      parts.push(`[gamesrc]${crop(g.game)},scale=${out.width}:${g.gameHeight}:flags=lanczos,setsar=1[game]`)
      parts.push('[cam][game]vstack=inputs=2[base]')
    } else {
      parts.push(`[0:v]${crop(g.game)},scale=${out.width}:${out.height}:flags=lanczos,setsar=1[base]`)
    }
    last = 'base'
  }

  let chain = `[${last}]fps=${fps}`
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

function loudnormFilter(m: LoudnessMeasurement | null): string {
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
      return ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-g', gop]
  }
}

/** Full FFmpeg argument list for one clip export. */
export function buildRenderArgs(spec: RenderSpec): string[] {
  const fps = Math.min(60, Math.max(24, Math.round(spec.sourceFps || 30)))
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
