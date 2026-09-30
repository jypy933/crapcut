// Measures a finished export with the app's own FFmpeg/ffprobe and runs the
// pure checks from core/exportChecks.ts on it (resolution, bars, silence,
// watermark, captions). A letterboxed vertical clip is re-rendered once with the
// blurred fill; anything else is only logged, and only a clip that is really
// broken (wrong size, missing or silent audio) turns into one plain sentence.

import { readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Platform } from '@shared/editPlan'
import type { Clip, ExportFormat } from '@shared/types'
import { safeZone } from '@shared/captionSafeZone'
import {
  cropSampleTimes,
  evaluateExport,
  EXPORT_CHECK_LIMITS,
  parseCropdetect,
  parseVolumeDetect,
  type AudioLevels,
  type CropSample,
  type ExportMeasurements,
  type ExportReport
} from '../core/exportChecks'
import { jobDir } from '../paths'
import { runTool } from '../tools/process'
import { isCancelled, UserError } from '../util/errors'
import { moveFile } from '../util/fsx'
import { logger } from '../util/log'
import { layoutFor, renderClipToFile, type ClipRenderDeps } from './clipRender'
import { probeMedia } from './media'

const log = logger('export-checks')

/** Arguments that print the loudest and mean sample of `file`'s audio on stderr. */
export const volumeDetectArgs = (file: string, seek = 0, duration?: number): string[] => [
  '-hide_banner',
  '-nostdin',
  ...(seek > 0 ? ['-ss', seek.toFixed(3)] : []),
  ...(duration ? ['-t', duration.toFixed(3)] : []),
  '-i',
  file,
  '-vn',
  '-af',
  'volumedetect',
  '-f',
  'null',
  '-'
]

/** Arguments that print the picture area of a few frames of `file` from `seek` on. */
export const cropDetectArgs = (file: string, seek: number): string[] => [
  '-hide_banner',
  '-nostdin',
  '-ss',
  seek.toFixed(3),
  '-i',
  file,
  '-an',
  '-vf',
  `cropdetect=limit=${EXPORT_CHECK_LIMITS.cropLimit}:round=2:reset=0`,
  '-frames:v',
  String(EXPORT_CHECK_LIMITS.cropFramesPerSample),
  '-f',
  'null',
  '-'
]

export const ffprobeFor = (ffmpeg: string): string => ffmpeg.replace(/ffmpeg(\.exe)?$/i, (_m, exe: string | undefined) => `ffprobe${exe ?? ''}`)

async function volumeOf(ffmpeg: string, args: string[], signal: AbortSignal | undefined): Promise<AudioLevels | null> {
  const r = await runTool(ffmpeg, args, { signal, timeoutMs: 120_000 })
  return parseVolumeDetect(r.stderr)
}

/** Probes `file` and samples its audio level and a few frames for black bars. */
export async function measureExport(ffmpeg: string, ffprobe: string, file: string, signal?: AbortSignal, opts: { skipBars?: boolean } = {}): Promise<ExportMeasurements> {
  const info = await probeMedia(ffprobe, file, signal)
  const video = { width: info.width, height: info.height, hasVideo: info.width > 0 && info.height > 0, hasAudio: info.hasAudio, durationSec: info.duration }
  const audio = info.hasAudio ? await volumeOf(ffmpeg, volumeDetectArgs(file), signal) : null
  const crops: CropSample[] = []
  if (video.hasVideo && !opts.skipBars) {
    for (const t of cropSampleTimes(info.duration)) {
      const r = await runTool(ffmpeg, cropDetectArgs(file, t), { signal, timeoutMs: 60_000 })
      const c = parseCropdetect(r.stderr)
      if (c) crops.push(c)
    }
  }
  return { video, audio, crops }
}

function readAss(workDir: string): string | null {
  try {
    return readFileSync(join(workDir, 'captions.ass'), 'utf8')
  } catch {
    return null
  }
}

/** Measures the export and judges it against what the clip was meant to be. */
async function reportFor(
  deps: ClipRenderDeps,
  clip: Clip,
  format: ExportFormat,
  platform: Platform | null,
  plannedSec: number,
  workDir: string,
  file: string,
  signal: AbortSignal
): Promise<ExportReport> {
  const ffmpeg = deps.tools.require('ffmpeg')
  const ffprobe = ffprobeFor(ffmpeg)
  const layoutIsBlur = format === 'vertical' && layoutFor(deps, clip).kind === 'blur_fill'
  const measured = await measureExport(ffmpeg, ffprobe, file, signal, { skipBars: layoutIsBlur })

  // Was the source's own sound there, and was it silent (a stretch Twitch muted)? Only looked at when the export has no usable sound.
  const source = join(jobDir(deps.paths, clip.jobId), 'clips', `${clip.id}.mp4`)
  const start = Math.max(clip.start, clip.source?.start ?? clip.start)
  const end = Math.min(clip.end, clip.source?.end ?? clip.end)
  const sourceInfo = await probeMedia(ffprobe, source, signal)
  let sourceSilent: boolean | null = null
  if (sourceInfo.hasAudio && (!measured.audio || measured.audio.maxDb <= EXPORT_CHECK_LIMITS.silentMaxDb)) {
    const levels = await volumeOf(ffmpeg, volumeDetectArgs(source, start - (clip.source?.start ?? start), end - start), signal)
    sourceSilent = levels ? levels.maxDb <= EXPORT_CHECK_LIMITS.silentMaxDb : null
  }

  return evaluateExport(measured, {
    format,
    sourceHadAudio: sourceInfo.hasAudio,
    sourceSilent,
    plannedMaxSec: Math.max(0, end - start, plannedSec),
    ass: readAss(workDir),
    zone: safeZone(format, platform ?? undefined),
    layoutIsBlur
  })
}

function logReport(id: string, report: ExportReport): void {
  const failed = report.checks.filter((c) => !c.ok)
  if (failed.length === 0) log.info(`${id}: export checks passed`)
  for (const c of failed) log.warn(`${id}: export check "${c.id}" failed (${c.severity}): ${c.detail}`)
}

/**
 * Checks the export at `partial` (just rendered from `clip`), fixes what can be
 * fixed silently and throws a plain `UserError` only for a clip that is really
 * broken. A measuring problem never fails an export: it is logged and skipped.
 * `platform` picks the safe zone the captions are judged against; `plannedSec`
 * is how long the render said the file would be (a cold open runs longer than
 * the cut it is made from).
 */
export async function verifyExport(
  deps: ClipRenderDeps,
  clip: Clip,
  format: ExportFormat,
  platform: Platform | null,
  plannedSec: number,
  workDir: string,
  partial: string,
  signal: AbortSignal
): Promise<void> {
  const id = `${platform ?? format} clip ${clip.rank}`
  let report: ExportReport
  try {
    report = await reportFor(deps, clip, format, platform, plannedSec, workDir, partial, signal)
  } catch (err) {
    if (isCancelled(err)) throw err
    log.warn(`${id}: could not run the export checks`, err)
    return
  }
  logReport(id, report)

  if (report.fix === 'blur_fill') {
    // Black bars in a cam or crop layout: try again with the blurred fill and keep it only when that really clears them.
    // A separate work folder: a render empties its own, and `partial` lives in this one.
    const fixDir = `${workDir}-fix`
    const fixed = join(fixDir, 'out.mp4')
    const plain: Clip = { ...clip, layoutId: null }
    try {
      await renderClipToFile(deps, plain, format, fixDir, fixed, signal, () => {}, { platform })
      const again = await reportFor(deps, plain, format, platform, plannedSec, fixDir, fixed, signal)
      logReport(`${id} (blur fill)`, again)
      if (!again.broken && !again.checks.some((c) => c.id === 'bars' && !c.ok)) {
        moveFile(fixed, partial)
        report = again
        log.info(`${id}: black bars replaced by the blurred fill`)
      }
    } catch (err) {
      if (isCancelled(err)) throw err
      log.warn(`${id}: blur-fill retry failed, keeping the first render`, err)
    } finally {
      rmSync(fixDir, { recursive: true, force: true })
    }
  }

  if (report.broken) throw new UserError('This clip did not export correctly. Try again.', { detail: `export checks failed: ${report.broken}` })
}
