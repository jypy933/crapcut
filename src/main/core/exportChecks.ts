// Checks a finished export against what the platforms penalise (research
// section 2.7): wrong size, black bars, missing or silent audio, a watermark or
// end card, captions outside the safe zone. Pure: it takes measurements that
// `pipeline/exportChecks.ts` made with ffprobe/FFmpeg and returns pass/fail per
// check, plus whether the clip is really broken and whether a fix is known.

import { OUTPUT_SIZE, type RenderFormat } from '@shared/layoutGeometry'
import {
  blockOverflow,
  defaultMarginX,
  estimateCaptionBlock,
  overflowsZone,
  type SafeZone
} from '@shared/captionSafeZone'

/** Tunable limits for the checks. */
export const EXPORT_CHECK_LIMITS = {
  /** A loudest sample at or below this (dB) counts as silent (a loudnormed clip peaks near -1.5). */
  silentMaxDb: -50,
  /** A dark band at least this many pixels tall or wide, on the same side in every sampled frame, counts as a bar. */
  barMinPx: 16,
  /** cropdetect's brightness limit (0-255) below which a pixel counts as black. */
  cropLimit: 24,
  /** Where in the clip (fractions of its length) frames are sampled for bars, and how many frames per sample. */
  cropSamples: [0.2, 0.5, 0.8] as number[],
  cropFramesPerSample: 3,
  /** Fewer usable samples than this and the bar check cannot say. */
  cropMinSamples: 2,
  /** A detected picture smaller than this share of the frame is a dark scene, not a bar. */
  cropMinAreaShare: 0.2,
  /** The file may run this much longer than the clip's planned length before it looks like an end card was added (seconds). */
  endCardToleranceSec: 5
}

export type ExportCheckId = 'resolution' | 'audio' | 'bars' | 'watermark' | 'captions'

export interface CheckResult {
  id: ExportCheckId
  ok: boolean
  /** How bad a failure is: `broken` is a clip nobody should post, `warn` is worth a log line only. */
  severity: 'broken' | 'warn'
  /** Plain detail for the local log (never shown in the UI). */
  detail: string
}

const pass = (id: ExportCheckId, detail: string): CheckResult => ({ id, ok: true, severity: 'warn', detail })

export interface VideoMeasure {
  width: number
  height: number
  hasVideo: boolean
  hasAudio: boolean
  durationSec: number
}

/** volumedetect's result; null when it did not run or could not be read. */
export interface AudioLevels {
  meanDb: number
  maxDb: number
}

/** The picture area cropdetect found in one sample, in frame pixels. */
export interface CropSample {
  x: number
  y: number
  w: number
  h: number
}

export interface ExportMeasurements {
  video: VideoMeasure
  audio: AudioLevels | null
  crops: CropSample[]
}

// ---- parsing tool output ----

/** mean and max volume from `volumedetect` (printed on stderr); null when absent. */
export function parseVolumeDetect(stderr: string): AudioLevels | null {
  const mean = /mean_volume:\s*(-?[\d.]+|-?inf)\s*dB/i.exec(stderr)
  const max = /max_volume:\s*(-?[\d.]+|-?inf)\s*dB/i.exec(stderr)
  if (!mean || !max) return null
  const n = (s: string): number => (/inf/i.test(s) ? -Infinity : Number(s))
  const levels = { meanDb: n(mean[1]!), maxDb: n(max[1]!) }
  return Number.isNaN(levels.meanDb) || Number.isNaN(levels.maxDb) ? null : levels
}

/** The last `crop=w:h:x:y` line cropdetect printed (it grows to cover every frame seen); null when it found no picture. */
export function parseCropdetect(stderr: string): CropSample | null {
  let last: CropSample | null = null
  for (const m of stderr.matchAll(/crop=(-?\d+):(-?\d+):(-?\d+):(-?\d+)/g)) {
    const [w, h, x, y] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4])]
    if (w > 0 && h > 0 && x >= 0 && y >= 0) last = { x, y, w, h }
  }
  return last
}

/** Seconds into a clip of `durationSec` at which to sample frames for bars. */
export function cropSampleTimes(durationSec: number): number[] {
  const last = Math.max(0, durationSec - 0.5)
  return EXPORT_CHECK_LIMITS.cropSamples.map((f) => Math.min(last, Math.max(0, f * durationSec)))
}

// ---- individual checks ----

export function checkResolution(video: VideoMeasure, format: RenderFormat): CheckResult {
  const want = OUTPUT_SIZE[format]
  if (!video.hasVideo) return { id: 'resolution', ok: false, severity: 'broken', detail: 'the file has no video stream' }
  if (video.width !== want.width || video.height !== want.height) {
    return { id: 'resolution', ok: false, severity: 'broken', detail: `size is ${video.width}x${video.height}, expected ${want.width}x${want.height}` }
  }
  return pass('resolution', `${video.width}x${video.height}`)
}

export interface AudioExpectation {
  /** The clip's source had an audio stream. */
  sourceHadAudio: boolean
  /** The source clip's own audio is silent (a Twitch-muted stretch); null when not measured. */
  sourceSilent: boolean | null
}

export function checkAudio(video: VideoMeasure, levels: AudioLevels | null, expect: AudioExpectation): CheckResult {
  const limit = EXPORT_CHECK_LIMITS.silentMaxDb
  if (!video.hasAudio) {
    return expect.sourceHadAudio
      ? { id: 'audio', ok: false, severity: 'broken', detail: 'the source had sound but the export has no audio stream' }
      : { id: 'audio', ok: false, severity: 'warn', detail: 'the source has no audio, so the export has none' }
  }
  if (!levels) return pass('audio', 'audio present, level not measured')
  if (levels.maxDb <= limit) {
    // A stretch Twitch muted is silent in the source too; that is not our fault.
    const muted = expect.sourceSilent === true || !expect.sourceHadAudio
    return { id: 'audio', ok: false, severity: muted ? 'warn' : 'broken', detail: `audio is silent (peak ${levels.maxDb} dB)${muted ? ', and so is the source' : ''}` }
  }
  return pass('audio', `peak ${levels.maxDb} dB, mean ${levels.meanDb} dB`)
}

/** Persistent dark band on each side over all samples (the smallest seen), in pixels. */
export interface Bars {
  top: number
  bottom: number
  left: number
  right: number
  /** Samples that had a usable picture area. */
  samples: number
}

export function barsFromCrops(crops: CropSample[], frame: { width: number; height: number }): Bars {
  const usable = crops.filter((c) => c.w * c.h >= frame.width * frame.height * EXPORT_CHECK_LIMITS.cropMinAreaShare)
  if (usable.length === 0) return { top: 0, bottom: 0, left: 0, right: 0, samples: 0 }
  const min = (f: (c: CropSample) => number): number => Math.max(0, Math.min(...usable.map(f)))
  return {
    top: min((c) => c.y),
    bottom: min((c) => frame.height - c.y - c.h),
    left: min((c) => c.x),
    right: min((c) => frame.width - c.x - c.w),
    samples: usable.length
  }
}

/** Fails when the same side of the frame is a black bar in every sampled frame. Inconclusive (passes) with too few samples. */
export function checkBars(video: VideoMeasure, crops: CropSample[]): CheckResult {
  const { barMinPx, cropMinSamples } = EXPORT_CHECK_LIMITS
  const bars = barsFromCrops(crops, video)
  if (bars.samples < cropMinSamples) return pass('bars', 'too few clear frames to judge bars')
  const sides = (['top', 'bottom', 'left', 'right'] as const).filter((s) => bars[s] >= barMinPx)
  if (sides.length === 0) return pass('bars', 'no black bars')
  return { id: 'bars', ok: false, severity: 'warn', detail: `black bars: ${sides.map((s) => `${s} ${bars[s]}px`).join(', ')}` }
}

const OWN_ASS_STYLES = new Set(['Caption', 'Chat'])

/**
 * No watermark and no end card from us: every ASS event is a caption or chat
 * line (no logo text, no URL, no product name), and the file is not
 * meaningfully longer than the clip was planned to be.
 */
export function checkNoWatermark(ass: string | null, actualSec: number, plannedMaxSec: number): CheckResult {
  const problems: string[] = []
  for (const line of (ass ?? '').split(/\r?\n/)) {
    if (!line.startsWith('Dialogue:')) continue
    const fields = line.slice('Dialogue:'.length).split(',')
    const style = fields[3]?.trim() ?? ''
    const text = fields.slice(9).join(',')
    if (!OWN_ASS_STYLES.has(style)) problems.push(`text in style "${style}"`)
    else if (/crapcut|https?:\/\/|www\./i.test(text)) problems.push('a link or product name in a caption')
  }
  if (actualSec > plannedMaxSec + EXPORT_CHECK_LIMITS.endCardToleranceSec) problems.push(`runs ${actualSec.toFixed(1)}s, planned at most ${plannedMaxSec.toFixed(1)}s`)
  return problems.length > 0 ? { id: 'watermark', ok: false, severity: 'warn', detail: [...new Set(problems)].join('; ') } : pass('watermark', 'nothing added')
}

/** What the caption style of an ASS file says about where its text sits. */
export interface AssCaptionLayout {
  frameWidth: number
  frameHeight: number
  fontSize: number
  outline: number
  marginX: number
  /** Largest size bump in any caption event (1 for none). */
  scale: number
  texts: string[]
  /** Lowest and highest caption centre (\pos y), in frame pixels. */
  centreYMin: number
  centreYMax: number
}

/** Reads the caption placement out of the ASS `buildAss` wrote; null when there are no caption events. */
export function captionLayoutFromAss(ass: string): AssCaptionLayout | null {
  const num = (re: RegExp, fallback: number): number => {
    const m = re.exec(ass)
    return m ? Number(m[1]) : fallback
  }
  const style = /^Style:\s*Caption,(.*)$/m.exec(ass)?.[1]?.split(',')
  if (!style) return null
  // Style fields after the name: Font, Size, 4 colours, 7 flags/scales/spacing/angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR ...
  const fontSize = Number(style[1])
  const outline = Number(style[15])
  const marginX = Number(style[19])
  const texts: string[] = []
  let scale = 1
  let lo = Infinity
  let hi = -Infinity
  for (const line of ass.split(/\r?\n/)) {
    const m = /^Dialogue:\s*[^,]*,[^,]*,[^,]*,Caption,(?:[^,]*,){5}(.*)$/.exec(line)
    if (!m) continue
    const body = m[1]!
    texts.push(body.replace(/\{[^}]*\}/g, '').replace(/\\N/g, ' ').replace(/\s+/g, ' ').trim())
    for (const s of body.matchAll(/\\fscy(\d+)/g)) scale = Math.max(scale, Number(s[1]) / 100)
    const pos = /\\pos\(\s*-?[\d.]+\s*,\s*(-?[\d.]+)\s*\)/.exec(body)
    if (pos) {
      lo = Math.min(lo, Number(pos[1]))
      hi = Math.max(hi, Number(pos[1]))
    }
  }
  if (texts.length === 0 || !Number.isFinite(lo) || [fontSize, outline, marginX].some((n) => Number.isNaN(n))) return null
  return { frameWidth: num(/^PlayResX:\s*(\d+)/m, 1080), frameHeight: num(/^PlayResY:\s*(\d+)/m, 1920), fontSize, outline, marginX, scale, texts, centreYMin: lo, centreYMax: hi }
}

/** Fails when the caption text, laid out from the ASS the export used, would spill past the zone. */
export function checkCaptionsInZone(ass: string | null, zone: SafeZone): CheckResult {
  const layout = ass ? captionLayoutFromAss(ass) : null
  if (!layout) return pass('captions', 'no captions')
  const block = estimateCaptionBlock({
    texts: layout.texts,
    fontSize: layout.fontSize,
    outline: layout.outline,
    scale: layout.scale,
    frameWidth: layout.frameWidth,
    marginX: layout.marginX || defaultMarginX(layout.frameWidth)
  })
  const a = blockOverflow(block, layout.centreYMin, layout.frameWidth, zone)
  const b = blockOverflow(block, layout.centreYMax, layout.frameWidth, zone)
  const worst = { left: Math.max(a.left, b.left), right: Math.max(a.right, b.right), top: Math.max(a.top, b.top), bottom: Math.max(a.bottom, b.bottom) }
  if (!overflowsZone(worst)) return pass('captions', `inside the safe zone (${block.lines} line${block.lines === 1 ? '' : 's'})`)
  const sides = (['left', 'right', 'top', 'bottom'] as const).filter((s) => worst[s] > 0).map((s) => `${s} ${worst[s]}px`)
  return { id: 'captions', ok: false, severity: 'warn', detail: `captions spill past the safe zone: ${sides.join(', ')}` }
}

// ---- the whole report ----

export interface ExportExpectations extends AudioExpectation {
  format: RenderFormat
  /** Longest the clip should run (its planned length), seconds. */
  plannedMaxSec: number
  /** The ASS file the export burned in, when it had one. */
  ass: string | null
  zone: SafeZone
  /**
   * The 9:16 layout is the blurred fill: its edges are a dark blur by design,
   * which the bar detector cannot tell from bars, so bars are not judged, and
   * there is nothing further to swap in.
   */
  layoutIsBlur: boolean
}

export interface ExportReport {
  checks: CheckResult[]
  /** One line for the log naming what makes the clip unfit to post; null when it is fine. */
  broken: string | null
  /** A re-render with this layout is known to fix a failed check; null when nothing can be fixed automatically. */
  fix: 'blur_fill' | null
}

export function evaluateExport(m: ExportMeasurements, e: ExportExpectations): ExportReport {
  const checks = [
    checkResolution(m.video, e.format),
    checkAudio(m.video, m.audio, e),
    e.layoutIsBlur ? pass('bars', 'blurred fill, bars not judged') : checkBars(m.video, m.crops),
    checkNoWatermark(e.ass, m.video.durationSec, e.plannedMaxSec),
    checkCaptionsInZone(e.ass, e.zone)
  ]
  const broken = checks.filter((c) => !c.ok && c.severity === 'broken').map((c) => c.detail)
  const barsFailed = checks.some((c) => c.id === 'bars' && !c.ok)
  return { checks, broken: broken.length > 0 ? broken.join('; ') : null, fix: barsFailed && e.format === 'vertical' && !e.layoutIsBlur ? 'blur_fill' : null }
}
