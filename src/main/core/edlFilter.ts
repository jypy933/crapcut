// Builds the FFmpeg filter_complex for one clip's EDL re-edit: reordered and
// trimmed segments joined as jump cuts, a punch-in zoom and shake done with
// `crop` (not `zoompan`), freeze frames, per-segment speed, overlays burned
// in with `ass` (not `drawtext`, which segfaults under some fontconfig
// setups), an SFX mix, and the export's existing loudness normalisation.
// Pure: no I/O, no processes. The graph is long, so the caller passes it
// through `-filter_complex_script` (a file) instead of `-filter_complex`, to
// stay clear of shell/argv quoting entirely.
//
// A pad produced by a filter can only feed one downstream filter in FFmpeg's
// graph syntax (the same convention `core/render.ts` and `core/bestOf.ts`
// follow with `split`/`asplit`): every pad this module reuses -- an input
// stream read once per segment, a concatenated stream read once per freeze --
// is split first.

import type { Layout } from '@shared/types'
import { assColor, assEscape } from '@shared/assText'
import { OUTPUT_SIZE, type RenderFormat, type Size } from '@shared/layoutGeometry'
import type { Edl, EdlSegment, FreezeCue, OverlayCue, ZoomKeyframe } from './edl'
import { concatDuration, freezeTotal, outputDuration } from './edl'
import { assTime } from './ass'
import { clampFps, crop, encoderArgs, filterValue, layoutBaseFilter, loudnormFilter, type AudioPlan, type EncoderId, type LoudnessMeasurement } from './render'

export { crop }

const SAMPLE_RATE = 48000
const AUDIO_FMT = `aresample=${SAMPLE_RATE},aformat=channel_layouts=stereo`

const fmtT = (n: number): string => n.toFixed(6)
const fmtNum = (n: number): string => String(Number(n.toFixed(6)))

/** `atempo` only ramps 0.5x-2x; chains several instances to cover the rest. */
export function atempoChain(speed: number): string[] {
  if (!(speed > 0)) throw new Error('speed must be positive')
  const filters: string[] = []
  let remaining = speed
  while (remaining > 2) {
    filters.push('atempo=2')
    remaining /= 2
  }
  while (remaining < 0.5) {
    filters.push('atempo=0.5')
    remaining /= 0.5
  }
  if (Math.abs(remaining - 1) > 1e-9) filters.push(`atempo=${fmtNum(remaining)}`)
  return filters
}

function sortZoom(zoom: readonly ZoomKeyframe[]): ZoomKeyframe[] {
  return [...zoom].sort((a, b) => a.t - b.t)
}

/** FFmpeg time expression for the punch-in scale at time `t` (1 = no zoom). Unescaped: callers embed it inside a filter option. */
export function zoomScaleExpr(zoom: readonly ZoomKeyframe[]): string {
  const sorted = sortZoom(zoom)
  if (sorted.length === 0) return '1'
  let expr = fmtNum(sorted[sorted.length - 1]!.scale)
  for (let i = sorted.length - 2; i >= 0; i--) {
    const a = sorted[i]!
    const b = sorted[i + 1]!
    const held =
      a.ease === 'snap' || b.t - a.t < 1e-6
        ? fmtNum(a.scale)
        : `(${fmtNum(a.scale)}+(${fmtNum(b.scale)}-${fmtNum(a.scale)})*(t-${fmtNum(a.t)})/${fmtNum(b.t - a.t)})`
    expr = `if(lt(t,${fmtNum(b.t)}),${held},${expr})`
  }
  expr = `if(lt(t,${fmtNum(sorted[0]!.t)}),${fmtNum(sorted[0]!.scale)},${expr})`
  return expr
}

/** FFmpeg time expression for the shake amplitude (output pixels) at time `t`, held stepwise per keyframe. */
export function shakeAmpExpr(zoom: readonly ZoomKeyframe[]): string {
  const sorted = sortZoom(zoom)
  if (sorted.length === 0) return '0'
  let expr = fmtNum(sorted[sorted.length - 1]!.shakeAmp ?? 0)
  for (let i = sorted.length - 2; i >= 0; i--) expr = `if(lt(t,${fmtNum(sorted[i + 1]!.t)}),${fmtNum(sorted[i]!.shakeAmp ?? 0)},${expr})`
  expr = `if(lt(t,${fmtNum(sorted[0]!.t)}),${fmtNum(sorted[0]!.shakeAmp ?? 0)},${expr})`
  return expr
}

/** The `crop` filter's w/h/x/y expressions for a punch-in zoom + shake on a `size` frame. Unescaped. */
export function zoomCropExpr(zoom: readonly ZoomKeyframe[], size: Size): { w: string; h: string; x: string; y: string } {
  const scale = zoomScaleExpr(zoom)
  const amp = shakeAmpExpr(zoom)
  const w = `${size.width}/(${scale})`
  const h = `${size.height}/(${scale})`
  const shakeX = `(${amp})*sin(2*PI*13*t)`
  const shakeY = `(${amp})*cos(2*PI*17*t)`
  const x = `max(0,min(${size.width}-(${w}),(${size.width}-(${w}))/2+${shakeX}))`
  const y = `max(0,min(${size.height}-(${h}),(${size.height}-(${h}))/2+${shakeY}))`
  return { w, h, x, y }
}

/** Escapes commas so an eval expression survives inside a filtergraph option (a bare comma would end the filter early). */
const escExpr = (s: string): string => s.replace(/,/g, '\\,')

function zoomCropFilter(zoom: readonly ZoomKeyframe[], size: Size): string | null {
  if (zoom.length === 0) return null
  const { w, h, x, y } = zoomCropExpr(zoom, size)
  // crop's x/y/w/h are re-evaluated every frame by default (there is no
  // `eval` option, unlike `scale`/`overlay`), so this is enough for a
  // time-varying punch-in with no `zoompan`.
  return `crop=w=${escExpr(w)}:h=${escExpr(h)}:x=${escExpr(x)}:y=${escExpr(y)},scale=${size.width}:${size.height}:flags=lanczos`
}

/** Splits a pad into `n` copies when more than one filter needs to read it; returns it unchanged for n<=1. */
function splitLabel(parts: string[], pad: string, n: number, prefix: string, audio: boolean): string[] {
  if (n <= 1) return [pad]
  const outs = Array.from({ length: n }, (_, i) => `${prefix}${i}`)
  parts.push(`[${pad}]${audio ? 'asplit' : 'split'}=${n}${outs.map((o) => `[${o}]`).join('')}`)
  return outs
}

function speedPts(speed: number): string {
  return speed === 1 ? 'PTS-STARTPTS' : `(PTS-STARTPTS)/${fmtNum(speed)}`
}

/** Trims and concatenates the video for every segment (jump cuts), reading `pad` once per segment. */
function segmentVideoChain(parts: string[], pad: string, segments: readonly EdlSegment[]): string {
  const ins = splitLabel(parts, pad, segments.length, 'vsrc', false)
  const labels = segments.map((s, i) => {
    const raw = `vseg${i}`
    parts.push(`[${ins[i]}]trim=start=${fmtT(s.srcStart)}:end=${fmtT(s.srcEnd)},setpts=${speedPts(s.speed)}[${raw}]`)
    return `[${raw}]`
  })
  const out = 'vseg'
  parts.push(`${labels.join('')}concat=n=${segments.length}:v=1:a=0[${out}]`)
  return out
}

/** Same idea for one audio pad, with `atempo` for a sped-up/slowed segment. */
function segmentAudioChain(parts: string[], pad: string, segments: readonly EdlSegment[], prefix: string): string {
  const ins = splitLabel(parts, pad, segments.length, `${prefix}src`, true)
  const labels = segments.map((s, i) => {
    const raw = `${prefix}${i}`
    const tempo = s.speed === 1 ? '' : `,${atempoChain(s.speed).join(',')}`
    parts.push(`[${ins[i]}]atrim=start=${fmtT(s.srcStart)}:end=${fmtT(s.srcEnd)},asetpts=PTS-STARTPTS${tempo}[${raw}]`)
    return `[${raw}]`
  })
  const out = `${prefix}seg`
  parts.push(`${labels.join('')}concat=n=${segments.length}:v=0:a=1[${out}]`)
  return out
}

/**
 * Splices a held frame into the video at every freeze cue: a 1-frame trim
 * held with `tpad=stop_mode=clone`. Every cut point is measured against the
 * original, unmodified `pad`, since every freeze is defined on that same
 * pre-freeze timeline (see `edl.ts`'s `FreezeCue`).
 */
function spliceFreezeVideo(parts: string[], pad: string, freeze: readonly FreezeCue[], fps: number): string {
  if (freeze.length === 0) return pad
  const sorted = [...freeze].sort((a, b) => a.atOutputT - b.atOutputT)
  const pieces = sorted.length * 2 + 1
  const ins = splitLabel(parts, pad, pieces, 'vfzin', false)
  const frameDur = 1 / fps
  const labels: string[] = []
  let prevEnd = 0
  let idx = 0
  for (const f of sorted) {
    parts.push(`[${ins[idx]}]trim=start=${fmtT(prevEnd)}:end=${fmtT(f.atOutputT)},setpts=PTS-STARTPTS[vfzbody${idx}]`)
    labels.push(`[vfzbody${idx}]`)
    idx++
    parts.push(
      `[${ins[idx]}]trim=start=${fmtT(f.atOutputT)}:duration=${fmtT(frameDur)},setpts=PTS-STARTPTS,tpad=stop_mode=clone:stop_duration=${fmtT(Math.max(0, f.holdSec - frameDur))}[vfzhold${idx}]`
    )
    labels.push(`[vfzhold${idx}]`)
    idx++
    prevEnd = f.atOutputT
  }
  parts.push(`[${ins[idx]}]trim=start=${fmtT(prevEnd)},setpts=PTS-STARTPTS[vfztail]`)
  labels.push('[vfztail]')
  parts.push(`${labels.join('')}concat=n=${pieces}:v=1:a=0[vfz]`)
  return 'vfz'
}

/** Same splice for audio: silence (`anullsrc`) fills each hold instead of a cloned frame. */
function spliceFreezeAudio(parts: string[], pad: string, freeze: readonly FreezeCue[]): string {
  if (freeze.length === 0) return pad
  const sorted = [...freeze].sort((a, b) => a.atOutputT - b.atOutputT)
  // Unlike the video side, a hold is pure `anullsrc` -- it never reads `pad`,
  // so only the body segments and the tail (one per freeze, plus one) split it.
  const pieces = sorted.length * 2 + 1
  const ins = splitLabel(parts, pad, sorted.length + 1, 'afzin', true)
  const labels: string[] = []
  let prevEnd = 0
  let bodyIdx = 0
  let holdIdx = 0
  for (const f of sorted) {
    parts.push(`[${ins[bodyIdx]}]atrim=start=${fmtT(prevEnd)}:end=${fmtT(f.atOutputT)},asetpts=PTS-STARTPTS[afzbody${bodyIdx}]`)
    labels.push(`[afzbody${bodyIdx}]`)
    bodyIdx++
    parts.push(`anullsrc=r=${SAMPLE_RATE}:cl=stereo:d=${fmtT(f.holdSec)}[afzhold${holdIdx}]`)
    labels.push(`[afzhold${holdIdx}]`)
    holdIdx++
    prevEnd = f.atOutputT
  }
  parts.push(`[${ins[bodyIdx]}]atrim=start=${fmtT(prevEnd)},asetpts=PTS-STARTPTS[afztail]`)
  labels.push('[afztail]')
  parts.push(`${labels.join('')}concat=n=${pieces}:v=0:a=1[afz]`)
  return 'afz'
}

/**
 * A seamless loop ending: instead of crossfading the whole clip against
 * itself (which balloons the duration -- `xfade` buffers every frame of both
 * inputs), only short tail/head sub-clips are crossfaded, and the rest of the
 * clip is concatenated back on unmodified.
 */
function spliceLoopVideo(parts: string[], pad: string, mainDuration: number, introSec: number, crossfadeSec: number): string {
  const tailStart = Math.max(0, mainDuration - crossfadeSec)
  const ins = splitLabel(parts, pad, 3, 'vloopin', false)
  parts.push(`[${ins[0]}]trim=start=${fmtT(0)}:end=${fmtT(tailStart)},setpts=PTS-STARTPTS[vloopbody]`)
  parts.push(`[${ins[1]}]trim=start=${fmtT(tailStart)}:end=${fmtT(mainDuration)},setpts=PTS-STARTPTS[vlooptail]`)
  parts.push(`[${ins[2]}]trim=start=${fmtT(0)}:end=${fmtT(introSec)},setpts=PTS-STARTPTS[vloophead]`)
  parts.push(`[vlooptail][vloophead]xfade=transition=fade:duration=${fmtT(crossfadeSec)}:offset=0[vloopjoin]`)
  parts.push('[vloopbody][vloopjoin]concat=n=2:v=1:a=0[vloop]')
  return 'vloop'
}

function spliceLoopAudio(parts: string[], pad: string, mainDuration: number, introSec: number, crossfadeSec: number): string {
  const tailStart = Math.max(0, mainDuration - crossfadeSec)
  const ins = splitLabel(parts, pad, 3, 'aloopin', true)
  parts.push(`[${ins[0]}]atrim=start=${fmtT(0)}:end=${fmtT(tailStart)},asetpts=PTS-STARTPTS[aloopbody]`)
  parts.push(`[${ins[1]}]atrim=start=${fmtT(tailStart)}:end=${fmtT(mainDuration)},asetpts=PTS-STARTPTS[alooptail]`)
  parts.push(`[${ins[2]}]atrim=start=${fmtT(0)}:end=${fmtT(introSec)},asetpts=PTS-STARTPTS[aloophead]`)
  parts.push(`[alooptail][aloophead]acrossfade=d=${fmtT(crossfadeSec)}[aloopjoin]`)
  parts.push('[aloopbody][aloopjoin]concat=n=2:v=0:a=1[aloop]')
  return 'aloop'
}

export interface EdlRenderSpec {
  /** The accepted clip's already-rendered/downloaded source file; segments address times inside it. */
  input: string
  source: Size
  sourceFps: number
  format: RenderFormat
  layout: Layout
  edl: Edl
  /** ASS file with the remapped word captions (`edlCaptions.ts` + the existing `buildAss`), or null. */
  captionsAssFile: string | null
  /** ASS file built with `buildOverlayAss`, or null. */
  overlayAssFile: string | null
  fontsDir: string | null
  audio: AudioPlan
  loudness: LoudnessMeasurement | null
  encoder: EncoderId
  /** Where the filter graph is written; passed to FFmpeg with `-filter_complex_script`. */
  filterScript: string
  output: string
}

function assStage(pad: string, parts: string[], assFile: string | null, fontsDir: string | null, outName: string): string {
  if (!assFile) return pad
  let f = `ass=${filterValue(assFile)}`
  if (fontsDir) f += `:fontsdir=${filterValue(fontsDir)}`
  parts.push(`[${pad}]${f}[${outName}]`)
  return outName
}

/** The video half of the graph, ending in `[vout]`. */
export function edlVideoFilter(spec: EdlRenderSpec): string {
  const parts: string[] = []
  const out = OUTPUT_SIZE[spec.format]
  const fps = clampFps(spec.sourceFps)
  const mainDuration = concatDuration(spec.edl.segments) + freezeTotal(spec.edl.freeze)
  const total = outputDuration(spec.edl)

  const vseg = segmentVideoChain(parts, '0:v', spec.edl.segments)
  const vfz = spliceFreezeVideo(parts, vseg, spec.edl.freeze, fps)

  parts.push(`[${vfz}]fps=${fps}[vfps]`)
  parts.push(...layoutBaseFilter('vfps', spec.format, spec.layout, spec.source))

  const zoomFilter = zoomCropFilter(spec.edl.zoom, out)
  let pad = 'base'
  if (zoomFilter) {
    parts.push(`[base]${zoomFilter}[vzoom]`)
    pad = 'vzoom'
  }

  pad = assStage(pad, parts, spec.captionsAssFile, spec.fontsDir, 'vcap')
  pad = assStage(pad, parts, spec.overlayAssFile, spec.fontsDir, 'vovl')
  parts.push(`[${pad}]format=yuv420p[vcore]`)
  pad = 'vcore'

  if (spec.edl.ending.kind === 'loop') pad = spliceLoopVideo(parts, pad, mainDuration, spec.edl.ending.introSec, spec.edl.ending.crossfadeSec)

  // A safety net against the frame this many splices can drift by: the final
  // length always matches `outputDuration(edl)` exactly.
  parts.push(`[${pad}]trim=start=${fmtT(0)}:end=${fmtT(total)},setpts=PTS-STARTPTS[vout]`)
  return parts.join(';')
}

/** The audio half of the graph, ending in `[aout]`, plus any extra `-i` inputs it needs (stems, music, SFX files). */
export function edlAudioFilter(spec: EdlRenderSpec): { inputs: string[][]; filter: string | null } {
  if (spec.audio.kind === 'silent') return { inputs: [], filter: null }

  const parts: string[] = []
  const mainDuration = concatDuration(spec.edl.segments) + freezeTotal(spec.edl.freeze)
  const total = outputDuration(spec.edl)
  const inputs: string[][] = []
  let nextInput = 1

  let mainPad: string
  if (spec.audio.kind === 'original') {
    parts.push(`[0:a]${AUDIO_FMT}[a0fmt]`)
    mainPad = segmentAudioChain(parts, 'a0fmt', spec.edl.segments, 'voice')
  } else {
    const voiceIdx = nextInput++
    inputs.push(['-i', spec.audio.voice])
    parts.push(`[${voiceIdx}:a]${AUDIO_FMT}[voicefmt]`)
    const voiceSeg = segmentAudioChain(parts, 'voicefmt', spec.edl.segments, 'voice')
    if (spec.audio.game) {
      const gameIdx = nextInput++
      inputs.push(['-i', spec.audio.game])
      parts.push(`[${gameIdx}:a]${AUDIO_FMT}[gamefmt]`)
      const gameSeg = segmentAudioChain(parts, 'gamefmt', spec.edl.segments, 'game')
      parts.push(`[${gameSeg}]volume=${spec.audio.gameGain.toFixed(3)}[gameg]`)
      parts.push(`[${voiceSeg}][gameg]amix=inputs=2:duration=first:normalize=0[mainmix]`)
      mainPad = 'mainmix'
    } else {
      mainPad = voiceSeg
    }
  }

  let corePad = spliceFreezeAudio(parts, mainPad, spec.edl.freeze)

  if (spec.audio.kind === 'stems' && spec.audio.music) {
    const musicIdx = nextInput++
    inputs.push(['-stream_loop', '-1', '-i', spec.audio.music])
    const fadeOut = Math.max(0, mainDuration - 1.5).toFixed(2)
    parts.push(`[${corePad}]asplit=2[duckedmain][duckkey]`)
    parts.push(`[${musicIdx}:a]${AUDIO_FMT},atrim=0:${mainDuration.toFixed(3)},volume=${spec.audio.musicGain.toFixed(3)},afade=t=in:d=1,afade=t=out:st=${fadeOut}:d=1.5[musicraw]`)
    parts.push('[musicraw][duckkey]sidechaincompress=threshold=0.04:ratio=6:attack=20:release=400[musicducked]')
    parts.push('[duckedmain][musicducked]amix=inputs=2:duration=first:normalize=0[withmusic]')
    corePad = 'withmusic'
  }

  if (spec.edl.sfx.length > 0) {
    const sfxPads: string[] = []
    for (const cue of spec.edl.sfx) {
      const idx = nextInput++
      inputs.push(['-i', cue.file])
      const delayMs = Math.max(0, Math.round(cue.t * 1000))
      const raw = `sfx${sfxPads.length}`
      parts.push(`[${idx}:a]${AUDIO_FMT},adelay=${delayMs}|${delayMs},volume=${cue.gainDb}dB[${raw}]`)
      sfxPads.push(`[${raw}]`)
    }
    parts.push(`[${corePad}]${sfxPads.join('')}amix=inputs=${1 + sfxPads.length}:duration=first:normalize=0[withsfx]`)
    corePad = 'withsfx'
  }

  parts.push(`[${corePad}]${loudnormFilter(spec.loudness)}[acore]`)
  let pad = 'acore'

  if (spec.edl.ending.kind === 'loop') pad = spliceLoopAudio(parts, pad, mainDuration, spec.edl.ending.introSec, spec.edl.ending.crossfadeSec)

  parts.push(`[${pad}]atrim=start=${fmtT(0)}:end=${fmtT(total)},asetpts=PTS-STARTPTS[aout]`)
  return { inputs, filter: parts.join(';') }
}

/** Combines the video and audio graphs into one `-filter_complex_script` body, plus any extra `-i` inputs the audio side needs. */
export function edlToFilterGraph(spec: EdlRenderSpec): { graph: string; audioInputs: string[][] } {
  const video = edlVideoFilter(spec)
  const audio = edlAudioFilter(spec)
  const graph = [video, audio.filter].filter((s): s is string => !!s).join(';')
  return { graph, audioInputs: audio.inputs }
}

/** Full FFmpeg argument list for one EDL re-edit. The caller must have already written `spec.filterScript` with `edlToFilterGraph(spec).graph`. */
export function buildEdlRenderArgs(spec: EdlRenderSpec): string[] {
  const { audioInputs } = edlToFilterGraph(spec)
  const fps = clampFps(spec.sourceFps)
  const args = ['-hide_banner', '-nostdin', '-y', '-i', spec.input, ...audioInputs.flat(), '-filter_complex_script', spec.filterScript, '-map', '[vout]']
  if (spec.audio.kind !== 'silent') args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '192k', '-ar', String(SAMPLE_RATE))
  else args.push('-an')
  args.push(...encoderArgs(spec.encoder, fps), '-pix_fmt', 'yuv420p', '-movflags', '+faststart', '-progress', 'pipe:1', '-nostats', spec.output)
  return args
}

export interface OverlayAssOptions {
  width: number
  height: number
  fontName: string
  fontSize: number
}

const OVERLAY_ALIGN: Record<OverlayCue['pos']['align'], number> = { left: 4, center: 5, right: 6 }

function overlayStyleLine(name: string, opts: OverlayAssOptions, sizeMul: number, alpha: number, outline: number): string {
  const primary = assColor('#FFFFFF')
  const back = assColor('#000000', alpha)
  const size = Math.round(opts.fontSize * sizeMul)
  return `Style: ${name},${opts.fontName},${size},${primary},${primary},${assColor('#000000')},${back},0,0,0,0,100,100,0,0,3,${outline},0,5,10,10,10,1`
}

/**
 * A small ASS file for the EDL's overlay cues (a quote bar or a fake chat
 * bubble) -- burned in with `ass` like the captions, never `drawtext`. Text
 * is used verbatim; only ASS control characters are escaped.
 */
export function buildOverlayAss(overlays: readonly OverlayCue[], opts: OverlayAssOptions): string {
  const styleLines = [overlayStyleLine('QuoteBar', opts, 1.15, 0x20, 10), overlayStyleLine('ChatBubble', opts, 0.85, 0x50, 6)]
  const eventLines = [...overlays]
    .sort((a, b) => a.t0 - b.t0)
    .map((o) => {
      const style = o.kind === 'quoteBar' ? 'QuoteBar' : 'ChatBubble'
      const an = OVERLAY_ALIGN[o.pos.align]
      const x = Math.round(o.pos.x * opts.width)
      const y = Math.round(o.pos.y * opts.height)
      return `Dialogue: 1,${assTime(o.t0)},${assTime(o.t1)},${style},,0,0,0,,{\\an${an}\\pos(${x},${y})}${assEscape(o.text)}`
    })

  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${opts.width}`,
    `PlayResY: ${opts.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styleLines,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...eventLines
  ]
  return `${lines.join('\n')}\n`
}
