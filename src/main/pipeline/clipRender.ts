// Renders one clip to a file: captions, layout, audio (original/stems) and
// the encoder hardware fallback. Used by the normal per-clip exporter and by
// the best-of joiner, so both stay in step with what review shows.

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clipWords } from '@shared/captions'
import { captionY } from '@shared/captionPlacement'
import { captionStyle } from '@shared/captionStyles'
import { buildChatOverlay, chatOverlayGeometry, chatPosition, DEFAULT_CHAT_OVERLAY_OPTIONS } from '@shared/chatOverlay'
import type { Clip, ExportFormat, HardwareProfile, Layout, Word } from '@shared/types'
import { buildAss, defaultAssStyle, type AssStyle, type ChatOverlayAssInput } from '../core/ass'
import { safeZone, fitCaptionStyle } from '@shared/captionSafeZone'
import { clipFacts, decideStructureHeuristically } from '../core/clipFacts'
import { outputDuration } from '../core/edl'
import { remapWordsToEdl } from '../core/edlCaptions'
import { buildEdlRenderArgs, buildOverlayAss, edlToFilterGraph, type EdlRenderSpec } from '../core/edlFilter'
import { EtaEstimator } from '../core/eta'
import {
  buildLoudnessMeasureArgs,
  buildRenderArgs,
  parseLoudnessMeasure,
  parseProgressSeconds,
  type AudioPlan,
  type EncoderId,
  type LoudnessMeasurement,
  type RenderSpec,
  type Size
} from '../core/render'
import { wordsIn } from '../core/transcript'
import { buildViralEdl } from '../core/viralEdit'
import { jobDir, type AppPaths } from '../paths'
import type { Store } from '../store'
import { runTool } from '../tools/process'
import type { ToolRegistry } from '../tools/registry'
import { isCancelled, UserError } from '../util/errors'
import { logger } from '../util/log'
import type { GpuLock } from './gpuLock'
import { probeMedia, type MediaInfo } from './media'
import { ensureSfxCache } from './sfxCache'
import { cachedLoudness, prepareStems, stemCacheKey, type StemCache } from './stems'

const log = logger('clip-render')

export const DEFAULT_LAYOUT: Layout = { id: 'default-blur', name: 'Full frame', kind: 'blur_fill', cam: null, game: { x: 0, y: 0, w: 1, h: 1 } }

export interface ClipRenderDeps {
  store: Store
  paths: AppPaths
  tools: ToolRegistry
  hw: () => HardwareProfile
  gpu: GpuLock
  /** Cached choice, shared with whatever else is exporting on this PC. */
  getEncoder: (ffmpeg: string) => Promise<EncoderId>
  /** Called once a hardware encoder has failed, so the cache can be retired after enough failures. */
  onHwEncoderFailed: () => void
}

/** Share of a clip's progress the voice separation takes when the audio option needs it. */
const STEM_SHARE = 0.4

/** Where a clip's video lives and which stretch of it is the clip. */
interface ClipCut {
  input: string
  ffmpeg: string
  media: MediaInfo
  start: number
  end: number
  duration: number
  /** Seconds into `input` where the clip starts. */
  seek: number
  /** Kept between renders (the work folder is wiped each time), so a second format of this clip reuses its stems and loudness. */
  stemCache: StemCache
}

async function locateClip(deps: ClipRenderDeps, clip: Clip, signal: AbortSignal): Promise<ClipCut> {
  if (!clip.source) throw new UserError('The video for this clip has not been downloaded yet.', { retryable: false })
  const dir = jobDir(deps.paths, clip.jobId)
  const input = join(dir, 'clips', `${clip.id}.mp4`)
  if (!existsSync(input)) throw new UserError('The video for this clip is missing. Retry the job to download it again.', { retryable: false })
  const ffmpeg = deps.tools.require('ffmpeg')
  const media = await probeMedia(ffmpeg.replace(/ffmpeg\.exe$/i, 'ffprobe.exe'), input, signal)

  const start = Math.max(clip.start, clip.source.start)
  const end = Math.min(clip.end, clip.source.end)
  const duration = end - start
  if (duration < 1) throw new UserError('This clip is too short to export.', { retryable: false })
  const seek = start - clip.source.start

  const stemCache: StemCache = { dir: join(dir, 'stems'), clipId: clip.id, key: stemCacheKey(seek, duration, input) }
  return { input, ffmpeg, media, start, end, duration, seek, stemCache }
}

/** Empties `workDir` and puts the caption font in it (`fonts/`), ready for captions and scratch files. */
function initWorkDir(deps: ClipRenderDeps, workDir: string): void {
  rmSync(workDir, { recursive: true, force: true })
  mkdirSync(join(workDir, 'fonts'), { recursive: true })
  // Only Montserrat needs bundling; other preset fonts are already on Windows.
  copyFileSync(join(deps.paths.resources, 'fonts', 'Montserrat-Black.ttf'), join(workDir, 'fonts', 'Montserrat-Black.ttf'))
}

export const layoutFor = (deps: ClipRenderDeps, clip: Clip): Layout => (clip.layoutId ? deps.store.layout(clip.layoutId) : null) ?? DEFAULT_LAYOUT

/** The caption style for `format`, with its height (and wrap width) pushed inside the platform safe zone when the streamer's placement would spill out of it. */
function captionAssStyle(clip: Clip, format: ExportFormat, words: Word[]): AssStyle {
  const style = defaultAssStyle(format, captionY(clip.captions, format), clip.captions.uppercase, captionStyle(clip.captions.styleId))
  const fit = fitCaptionStyle(words, style, safeZone(format))
  if (fit.adjusted) log.info(`captions moved into the ${format} safe zone (y ${style.y.toFixed(3)} -> ${fit.style.y.toFixed(3)}, margin ${fit.style.marginX ?? 'default'})`)
  return fit.style
}

/** Writes the clip's captions (and chat overlay) to `captions.ass` in `workDir`; null when it has neither. */
function writeCaptionsAss(clip: Clip, format: ExportFormat, workDir: string, layout: Layout, cut: ClipCut): string | null {
  const captionsOn = clip.captions.enabled
  const chatOn = clip.chatOverlay && clip.chatMessages.length > 0
  if (!captionsOn && !chatOn) return null
  const words = captionsOn ? clipWords(clip.words, cut.start, cut.end) : []
  const style = captionAssStyle(clip, format, words)
  let chat: ChatOverlayAssInput | undefined
  if (chatOn) {
    const source = { width: cut.media.width, height: cut.media.height }
    const geometry = chatOverlayGeometry(format, layout, source, captionsOn ? style.y : null, DEFAULT_CHAT_OVERLAY_OPTIONS, chatPosition(clip.chatPos, format))
    const lines = buildChatOverlay(clip.chatMessages, cut.start, cut.end, geometry)
    if (lines.length > 0) chat = { lines, font: { fontName: 'Segoe UI', fontSize: DEFAULT_CHAT_OVERLAY_OPTIONS.fontSize } }
  }
  writeFileSync(join(workDir, 'captions.ass'), buildAss(words, style, chat))
  return 'captions.ass'
}

/** The clip's audio plan (original, or stems separated for this clip only) and, for the original, its measured loudness. */
async function prepareClipAudio(
  deps: ClipRenderDeps,
  clip: Clip,
  cut: ClipCut,
  workDir: string,
  signal: AbortSignal,
  onStemProgress: (f: number) => void
): Promise<{ audio: AudioPlan; loudness: LoudnessMeasurement | null }> {
  const { input, ffmpeg, media, seek, duration, stemCache } = cut
  let audio: AudioPlan = media.hasAudio ? { kind: 'original' } : { kind: 'silent' }
  if (media.hasAudio && clip.audio !== 'original') {
    if (clip.audio === 'voice_music' && !clip.musicPath) throw new UserError('Pick a music file for this clip first.', { retryable: false })
    const stems = await prepareStems({
      ffmpeg,
      tools: deps.tools,
      hw: deps.hw(),
      gpu: deps.gpu,
      input,
      seek,
      duration,
      workDir,
      cache: stemCache,
      signal,
      onProgress: onStemProgress
    })
    audio = {
      kind: 'stems',
      voice: stems.voice,
      game: clip.audio === 'voice_game' ? stems.background : null,
      gameGain: 0.3,
      music: clip.audio === 'voice_music' ? clip.musicPath : null,
      musicGain: 0.22
    }
  }

  let loudness: LoudnessMeasurement | null = null
  if (audio.kind === 'original') loudness = await cachedLoudness(stemCache, () => measureLoudness(ffmpeg, input, seek, duration, signal))
  return { audio, loudness }
}

/** A kept clip ready to go into the best-of graph: everything a normal 16:9 export prepares before its one encode. */
export interface BestOfPrepared {
  input: string
  seek: number
  duration: number
  source: Size
  layout: Layout
  /** Captions file inside the clip's work folder, or null. */
  assFile: string | null
  /** Caption font folder inside the clip's work folder. */
  fontsDir: string
  audio: AudioPlan
  loudness: LoudnessMeasurement | null
}

/**
 * Everything a plain 16:9 export of `clip` does before it encodes -- cut,
 * layout, captions (and chat overlay), voice separation, loudness -- without
 * encoding. The best-of joiner puts the results into one graph. Always the
 * plain cut, never the clip's automatic edit: a per-clip loop ending, freeze
 * or punch-in is built for a clip watched on its own, and fights the
 * best-of's crossfade join. `onProgress` covers the voice separation only.
 */
export async function prepareClipForBestOf(deps: ClipRenderDeps, clip: Clip, workDir: string, signal: AbortSignal, onProgress: (f: number) => void): Promise<BestOfPrepared> {
  const cut = await locateClip(deps, clip, signal)
  initWorkDir(deps, workDir)
  const layout = layoutFor(deps, clip)
  const assFile = writeCaptionsAss(clip, 'horizontal', workDir, layout, cut)
  const { audio, loudness } = await prepareClipAudio(deps, clip, cut, workDir, signal, onProgress)
  return {
    input: cut.input,
    seek: cut.seek,
    duration: cut.duration,
    source: { width: cut.media.width, height: cut.media.height },
    layout,
    assFile,
    fontsDir: 'fonts',
    audio,
    loudness
  }
}

/**
 * Renders `clip` in `format` to `outputPath`, using `workDir` for captions,
 * fonts and stem-separation scratch files. Mirrors a normal export exactly
 * (same captions, audio option, layout and encoder choice); the caller picks
 * where the result ends up.
 */
export async function renderClipToFile(
  deps: ClipRenderDeps,
  clip: Clip,
  format: ExportFormat,
  workDir: string,
  outputPath: string,
  signal: AbortSignal,
  onProgress: (f: number, etaSec: number | null) => void
): Promise<void> {
  const cut = await locateClip(deps, clip, signal)
  const { input, ffmpeg, media, seek, duration } = cut
  initWorkDir(deps, workDir)
  const layout = layoutFor(deps, clip)

  if (clip.autoEdit) {
    await renderAutoEditToFile(deps, clip, format, workDir, outputPath, cut, layout, signal, onProgress)
    return
  }

  const assFile = writeCaptionsAss(clip, format, workDir, layout, cut)

  // Audio: original, or stems for the voice options (separated only for this clip).
  const { audio, loudness } = await prepareClipAudio(deps, clip, cut, workDir, signal, (f) => onProgress(f * STEM_SHARE, null))
  const stemShare = audio.kind === 'stems' ? STEM_SHARE : 0

  const spec = (encoder: EncoderId): RenderSpec => ({
    input,
    seek,
    duration,
    source: { width: media.width, height: media.height },
    sourceFps: media.fps,
    format,
    layout,
    assFile,
    fontsDir: 'fonts',
    audio,
    loudness,
    encoder,
    output: outputPath
  })

  const eta = new EtaEstimator()
  const encode = async (encoder: EncoderId): Promise<void> => {
    await runTool(ffmpeg, buildRenderArgs(spec(encoder)), {
      cwd: workDir,
      signal,
      lowPriority: true,
      onStdout: (line) => {
        const s = parseProgressSeconds(line)
        if (s !== null) {
          const f = stemShare + (1 - stemShare) * Math.min(1, s / duration)
          onProgress(f, eta.update(f, 1))
        }
      }
    })
  }

  const encoder = await deps.getEncoder(ffmpeg)
  try {
    await encode(encoder)
  } catch (err) {
    if (isCancelled(err) || encoder === 'libx264') throw err
    deps.onHwEncoderFailed()
    await encode('libx264')
  }
}

/** First loudnorm pass over the clip's plain cut; null when it could not be measured (the render then normalises in one pass). */
async function measureLoudness(ffmpeg: string, input: string, seek: number, duration: number, signal: AbortSignal): Promise<LoudnessMeasurement | null> {
  const measured = await runTool(ffmpeg, buildLoudnessMeasureArgs(input, seek, duration), { signal }).catch((err) => {
    if (isCancelled(err)) throw err
    return null
  })
  return measured ? parseLoudnessMeasure(measured.stderr) : null
}

/**
 * The `clip.autoEdit` path: builds the house-look EDL and renders it with
 * `buildEdlRenderArgs` instead of the plain `buildRenderArgs`. Layout, audio
 * options and encoder fallback all match the plain path exactly; captions are
 * remapped onto the EDL's re-timed output instead of just windowed. The chat
 * overlay has no such remap yet, so it is left off an auto-edited clip rather
 * than show it at the wrong moment -- turning `autoEdit` off brings it back.
 */
async function renderAutoEditToFile(
  deps: ClipRenderDeps,
  clip: Clip,
  format: ExportFormat,
  workDir: string,
  outputPath: string,
  cut: ClipCut,
  layout: Layout,
  signal: AbortSignal,
  onProgress: (f: number, etaSec: number | null) => void
): Promise<void> {
  const { input, ffmpeg, media, start, end, seek, duration } = cut
  const decision = clip.structureDecision ?? decideStructureHeuristically(clip)
  const facts = { ...clipFacts(clip), window: { start, end } }
  const sfx = await ensureSfxCache(ffmpeg, join(deps.paths.tools, 'sfx'))
  const edl = buildViralEdl(decision, facts, { sfx })

  let captionsAssFile: string | null = null
  if (clip.captions.enabled) {
    // Shifted to clip-relative seconds (0 = `start`), matching the EDL's own
    // segments, then remapped onto the edited output timeline.
    const relativeWords = wordsIn(clip.words, start, end).map((w) => ({ t0: Math.max(0, w.t0 - start), t1: Math.min(end, w.t1) - start, text: w.text }))
    const remapped = remapWordsToEdl(relativeWords, edl)
    writeFileSync(join(workDir, 'captions.ass'), buildAss(remapped, captionAssStyle(clip, format, remapped)))
    captionsAssFile = 'captions.ass'
  }

  let overlayAssFile: string | null = null
  if (edl.overlays.length > 0) {
    const overlaySize = format === 'vertical' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 }
    writeFileSync(
      join(workDir, 'overlay.ass'),
      buildOverlayAss(edl.overlays, { width: overlaySize.width, height: overlaySize.height, fontName: 'Segoe UI', fontSize: format === 'vertical' ? 44 : 36 })
    )
    overlayAssFile = 'overlay.ass'
  }

  // The loudness is measured on the clip's plain cut, before the EDL
  // trims/reorders it -- the same approximation the plain path already makes
  // for a stems export (no measurement at all there), just one step short of
  // exact here since the EDL never invents sound, only rearranges what was measured.
  const { audio, loudness } = await prepareClipAudio(deps, clip, cut, workDir, signal, (f) => onProgress(f * STEM_SHARE, null))
  const stemShare = audio.kind === 'stems' ? STEM_SHARE : 0

  const filterScript = 'graph.txt'
  const spec = (encoder: EncoderId): EdlRenderSpec => ({
    input,
    seek,
    duration,
    source: { width: media.width, height: media.height },
    sourceFps: media.fps,
    format,
    layout,
    edl,
    captionsAssFile,
    overlayAssFile,
    fontsDir: 'fonts',
    audio,
    loudness,
    encoder,
    filterScript,
    output: outputPath
  })

  const total = outputDuration(edl)
  const eta = new EtaEstimator()
  const encode = async (encoder: EncoderId): Promise<void> => {
    const built = spec(encoder)
    writeFileSync(join(workDir, filterScript), edlToFilterGraph(built).graph)
    await runTool(ffmpeg, buildEdlRenderArgs(built), {
      cwd: workDir,
      signal,
      lowPriority: true,
      onStdout: (line) => {
        const s = parseProgressSeconds(line)
        if (s !== null) {
          const f = stemShare + (1 - stemShare) * Math.min(1, s / total)
          onProgress(f, eta.update(f, 1))
        }
      }
    })
  }

  const encoder = await deps.getEncoder(ffmpeg)
  try {
    await encode(encoder)
  } catch (err) {
    if (isCancelled(err) || encoder === 'libx264') throw err
    deps.onHwEncoderFailed()
    await encode('libx264')
  }
}
