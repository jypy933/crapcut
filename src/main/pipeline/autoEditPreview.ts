// A small, fast preview of a clip's automatic viral edit for the Review
// screen: same EDL, captions and sound effects a real export would use, but
// rendered small and at the lowest-effort encoder settings so it is ready
// quickly. Requests are debounced (an edit mid-drag should not queue a render
// per keystroke), a newer request for the same clip cancels whatever was
// still rendering, and the result is cached under the job's work folder,
// keyed by a hash of everything that could change it -- an unrelated
// property edit never re-renders it.

import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { AutoEditPreviewState, ExportFormat, Layout } from '@shared/types'
import { captionY } from '@shared/captionPlacement'
import { captionStyle } from '@shared/captionStyles'
import { buildAss, defaultAssStyle } from '../core/ass'
import { clipFacts, decideStructureHeuristically } from '../core/clipFacts'
import { buildEdlRenderArgs, buildOverlayAss, edlToFilterGraph, type EdlRenderSpec } from '../core/edlFilter'
import { remapWordsToEdl } from '../core/edlCaptions'
import { wordsIn } from '../core/transcript'
import { buildViralEdl } from '../core/viralEdit'
import { jobDir, type AppPaths } from '../paths'
import type { Store } from '../store'
import { runTool } from '../tools/process'
import type { ToolRegistry } from '../tools/registry'
import { ensureSfxCache } from './sfxCache'
import { probeMedia } from './media'
import { logger } from '../util/log'

const log = logger('autoEditPreview')

const DEBOUNCE_MS = 600
/** Bump when how a preview is rendered changes, so files cached by an older render are not shown. */
const PREVIEW_VERSION = 2
const PREVIEW_FPS = 30
const PREVIEW_DEFAULT_LAYOUT: Layout = { id: 'preview-default', name: 'Full frame', kind: 'blur_fill', cam: null, game: { x: 0, y: 0, w: 1, h: 1 } }
const PREVIEW_SIZE: Record<ExportFormat, { width: number; height: number }> = {
  vertical: { width: 360, height: 640 },
  horizontal: { width: 640, height: 360 }
}

export interface AutoEditPreviewEvents {
  onChanged: (state: AutoEditPreviewState) => void
}

export class AutoEditPreviewService {
  private timers = new Map<string, NodeJS.Timeout>()
  private controllers = new Map<string, AbortController>()
  private states = new Map<string, AutoEditPreviewState>()

  constructor(
    private readonly store: Store,
    private readonly paths: AppPaths,
    private readonly tools: ToolRegistry,
    private readonly events: AutoEditPreviewEvents
  ) {}

  state(clipId: string): AutoEditPreviewState {
    return this.states.get(clipId) ?? { clipId, status: 'off', version: null }
  }

  /** Debounced request for `clipId`'s current auto-edit preview, in `format`; returns the state known right now. */
  request(clipId: string, format: ExportFormat): AutoEditPreviewState {
    const existing = this.timers.get(clipId)
    if (existing) clearTimeout(existing)
    this.timers.set(
      clipId,
      setTimeout(() => {
        this.timers.delete(clipId)
        void this.run(clipId, format)
      }, DEBOUNCE_MS)
    )
    return this.state(clipId)
  }

  private set(state: AutoEditPreviewState): void {
    this.states.set(state.clipId, state)
    this.events.onChanged(state)
  }

  private async run(clipId: string, format: ExportFormat): Promise<void> {
    this.controllers.get(clipId)?.abort()
    const controller = new AbortController()
    this.controllers.set(clipId, controller)
    const signal = controller.signal

    const clip = this.store.clip(clipId)
    if (!clip || !clip.source || !clip.autoEdit) {
      this.set({ clipId, status: 'off', version: null })
      return
    }

    try {
      const decision = clip.structureDecision ?? decideStructureHeuristically(clip)
      const start = Math.max(clip.start, clip.source.start)
      const end = Math.min(clip.end, clip.source.end)
      const facts = { ...clipFacts(clip), window: { start, end } }

      const ffmpeg = this.tools.require('ffmpeg')
      const sfx = await ensureSfxCache(ffmpeg, join(this.paths.tools, 'sfx'))
      const edl = buildViralEdl(decision, facts, { sfx })

      const dir = previewDir(this.paths, clip.jobId)
      mkdirSync(dir, { recursive: true })
      const layout = clip.layoutId ? this.store.layout(clip.layoutId) : null
      const key = cacheKey(edl, clip, layout, format)
      const file = join(dir, `${clipId}-${key}.mp4`)
      if (existsSync(file)) {
        this.set({ clipId, status: 'ready', version: key })
        return
      }
      this.set({ clipId, status: 'building', version: null })

      // The caption font the export bundles (other preset fonts are already on Windows).
      mkdirSync(join(dir, 'fonts'), { recursive: true })
      const font = join(dir, 'fonts', 'Montserrat-Black.ttf')
      if (!existsSync(font)) copyFileSync(join(this.paths.resources, 'fonts', 'Montserrat-Black.ttf'), font)

      const input = join(jobDir(this.paths, clip.jobId), 'clips', `${clip.id}.mp4`)
      const ffprobe = ffmpeg.replace(/ffmpeg\.exe$/i, 'ffprobe.exe')
      const media = await probeMedia(ffprobe, input, signal)
      const seek = start - clip.source.start
      const duration = end - start

      let captionsAssFile: string | null = null
      if (clip.captions.enabled) {
        const relativeWords = wordsIn(clip.words, start, end).map((w) => ({ t0: Math.max(0, w.t0 - start), t1: Math.min(end, w.t1) - start, text: w.text }))
        const remapped = remapWordsToEdl(relativeWords, edl)
        const y = captionY(clip.captions, format)
        writeFileSync(join(dir, `${clipId}-captions.ass`), buildAss(remapped, defaultAssStyle(format, y, clip.captions.uppercase, captionStyle(clip.captions.styleId))))
        captionsAssFile = `${clipId}-captions.ass`
      }

      let overlayAssFile: string | null = null
      if (edl.overlays.length > 0) {
        const overlaySize = format === 'vertical' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 }
        writeFileSync(
          join(dir, `${clipId}-overlay.ass`),
          buildOverlayAss(edl.overlays, { width: overlaySize.width, height: overlaySize.height, fontName: 'Segoe UI', fontSize: format === 'vertical' ? 44 : 36 })
        )
        overlayAssFile = `${clipId}-overlay.ass`
      }

      // One pass straight to preview size: the layout, zoom and captions all
      // run on the small frame (libass scales the ASS files from their PlayRes).
      const tmp = join(dir, `${clipId}.tmp.mp4`)
      const spec: EdlRenderSpec = {
        input,
        seek,
        duration,
        source: { width: media.width, height: media.height },
        sourceFps: media.fps,
        format,
        layout: layout ?? PREVIEW_DEFAULT_LAYOUT,
        edl,
        captionsAssFile,
        overlayAssFile,
        fontsDir: 'fonts',
        audio: media.hasAudio ? { kind: 'original' } : { kind: 'silent' },
        loudness: null,
        encoder: 'libx264',
        filterScript: `${clipId}-preview-graph.txt`,
        output: `${clipId}.tmp.mp4`,
        outputSize: PREVIEW_SIZE[format],
        fps: PREVIEW_FPS
      }
      writeFileSync(join(dir, spec.filterScript), edlToFilterGraph(spec).graph)
      await runTool(ffmpeg, fastenPreview(buildEdlRenderArgs(spec)), { cwd: dir, signal, lowPriority: true })
      renameSync(tmp, file)
      pruneOldPreviews(dir, clipId, file)

      this.set({ clipId, status: 'ready', version: key })
    } catch (err) {
      if (signal.aborted) return
      log.warn(`preview failed for clip ${clipId.slice(0, 8)}`, err)
      this.set({ clipId, status: 'error', version: null })
    }
  }
}

/** The `buildEdlRenderArgs` for a libx264 export, made cheap to encode and to play for a throwaway preview. */
function fastenPreview(args: string[]): string[] {
  const out = [...args]
  const preset = out.indexOf('-preset')
  if (preset >= 0) out.splice(preset, 2, '-preset', 'ultrafast', '-tune', 'fastdecode')
  const crf = out.indexOf('-crf')
  if (crf >= 0) out[crf + 1] = '30'
  const audioRate = out.indexOf('-b:a')
  if (audioRate >= 0) out[audioRate + 1] = '96k'
  return out
}

function previewDir(paths: AppPaths, jobId: string): string {
  return join(jobDir(paths, jobId), 'previews')
}

/** The newest cached preview file for a clip, if any -- used by the media protocol handler to serve it. */
export function findPreviewFile(paths: AppPaths, jobId: string, clipId: string): string | null {
  const dir = previewDir(paths, jobId)
  if (!existsSync(dir)) return null
  const match = readdirSync(dir)
    .filter((f) => f.startsWith(`${clipId}-`) && f.endsWith('.mp4') && !f.includes('.tmp'))
    .map((f) => ({ f, mtime: statSync(join(dir, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime)[0]
  return match ? join(dir, match.f) : null
}

/**
 * A stable, short key over everything that changes what the preview looks
 * like. The preview always plays the original audio and has no chat overlay,
 * so the clip's audio option and chat toggle are left out on purpose.
 */
function cacheKey(edl: unknown, clip: { words: unknown; captions: unknown; source: unknown }, layout: unknown, format: ExportFormat): string {
  return createHash('sha1')
    .update(JSON.stringify({ v: PREVIEW_VERSION, edl, words: clip.words, captions: clip.captions, source: clip.source, layout, format }))
    .digest('hex')
    .slice(0, 20)
}

/** Keeps only the file just rendered for a clip; an older cached edit is never shown again. */
function pruneOldPreviews(dir: string, clipId: string, keep: string): void {
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(`${clipId}-`) || !f.endsWith('.mp4')) continue
    const full = join(dir, f)
    if (full !== keep) rmSync(full, { force: true })
  }
}
