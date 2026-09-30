// Export lane: renders accepted clips one at a time, separately from the
// analysis pipeline so reviewing and exporting never wait for a long job.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Platform } from '@shared/editPlan'
import { normalizePlatforms, PLATFORM_LABELS, type ClipVersion } from '@shared/platformExport'
import type { Clip, ExportFormat, ExportItem, HardwareProfile } from '@shared/types'
import { jobDir, type AppPaths } from '../paths'
import type { Store } from '../store'
import { chooseEncoder } from '../tools/encoders'
import type { EncoderId } from '../core/render'
import type { ToolRegistry } from '../tools/registry'
import { UserError, isCancelled, userMessage } from '../util/errors'
import { moveFile } from '../util/fsx'
import { logger } from '../util/log'
import { ensureClipNormalized } from './clipNormalize'
import { DEFAULT_LAYOUT, prepareClipForBestOf, renderClipToFile, type BestOfPrepared, type ClipRenderDeps } from './clipRender'
import { verifyExport } from './exportChecks'
import type { GpuLock } from './gpuLock'
import { loadMeta } from './steps'

const log = logger('export')

export { DEFAULT_LAYOUT }

/** Safe file name: no reserved characters, no trailing dots, not too long. */
export function safeFileName(s: string, max = 80): string {
  const cleaned = s
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '')
  const cut = cleaned.slice(0, max).trim()
  const name = cut || 'clip'
  return /^(con|prn|aux|nul|com\d|lpt\d)$/i.test(name) ? `${name}_` : name
}

/** `01 Title (TikTok).mp4`; 16:9 says `16x9`, an old export without a platform `9x16`, and the cold-open version says so, so both versions can sit side by side. */
export function exportFileName(clip: Clip, format: ExportFormat, platform: Platform | null = null, version: ClipVersion = 'straight'): string {
  const tag = format === 'horizontal' ? '16x9' : platform ? PLATFORM_LABELS[platform] : '9x16'
  const cold = version === 'coldOpen' ? ' cold open' : ''
  return `${String(clip.rank).padStart(2, '0')} ${safeFileName(clip.title, 60)} (${tag}${cold}).mp4`
}

const EXPORT_PLATFORMS_KEY = 'exportPlatforms'

export interface ExporterEvents {
  onChanged: (item: ExportItem) => void
}

export class Exporter {
  private queue: string[] = []
  private active: { id: string; controller: AbortController } | null = null
  private encoder: EncoderId | null = null
  private hwFailures = 0
  private progress = new Map<string, { progress: number; etaSec: number | null }>()
  private lastEmit = 0

  constructor(
    private readonly store: Store,
    private readonly paths: AppPaths,
    private readonly tools: ToolRegistry,
    private readonly hw: () => HardwareProfile,
    private readonly gpu: GpuLock,
    /** Shared with the best-of builder so an export and a build never encode at the same time. */
    private readonly encodeLock: GpuLock,
    private readonly events: ExporterEvents
  ) {}

  list(jobId?: string): ExportItem[] {
    return this.store.exports(jobId).map((e) => ({ ...e, ...(this.progress.get(e.id) ?? {}) }))
  }

  /** True while any export is running or queued (closing the window should not interrupt it). */
  hasWork(): boolean {
    return this.active !== null || this.queue.length > 0
  }

  private emit(id: string, force = false): void {
    const now = Date.now()
    if (!force && now - this.lastEmit < 250) return
    this.lastEmit = now
    const item = this.list().find((e) => e.id === id)
    if (item) this.events.onChanged(item)
  }

  /** The platforms vertical exports are made for: remembered, all three until he unticks one. */
  platforms(): Platform[] {
    return normalizePlatforms(this.store.get<unknown>(EXPORT_PLATFORMS_KEY))
  }

  setPlatforms(platforms: readonly Platform[]): Platform[] {
    const kept = normalizePlatforms(platforms)
    this.store.set(EXPORT_PLATFORMS_KEY, kept)
    return kept
  }

  /** Queues exports for the given clips: one per remembered platform for vertical, one for 16:9. */
  add(jobId: string, clipIds: string[]): string[] {
    const ids: string[] = []
    const platforms = this.platforms()
    for (const clipId of clipIds) {
      const clip = this.store.clip(clipId)
      if (!clip || clip.jobId !== jobId) continue
      const targets: { format: ExportFormat; platform: Platform | null }[] = []
      if (clip.formats.vertical) for (const platform of platforms) targets.push({ format: 'vertical', platform })
      if (clip.formats.horizontal) targets.push({ format: 'horizontal', platform: null })
      for (const t of targets) {
        const id = this.store.addExport(jobId, clipId, t.format, t.platform)
        ids.push(id)
        this.queue.push(id)
        this.emit(id, true)
      }
    }
    void this.pump()
    return ids
  }

  /** Re-queues exports interrupted by a crash or close. */
  resumeQueued(): void {
    for (const e of this.store.exports()) if (e.status === 'queued' && !this.queue.includes(e.id)) this.queue.push(e.id)
    void this.pump()
  }

  cancel(id: string): void {
    const i = this.queue.indexOf(id)
    if (i >= 0) {
      this.queue.splice(i, 1)
      this.store.updateExport(id, { status: 'cancelled' })
      this.emit(id, true)
    }
    if (this.active?.id === id) this.active.controller.abort()
  }

  private running: Promise<void> | null = null

  /** Stops the current export; it goes back to the queue for next time. */
  async shutdown(): Promise<void> {
    this.queue = []
    if (this.active) {
      this.shuttingDown = true
      this.active.controller.abort()
    }
    await this.running
  }

  private shuttingDown = false

  private async pump(): Promise<void> {
    if (this.active || this.shuttingDown) return
    const id = this.queue.shift()
    if (!id) return
    const controller = new AbortController()
    this.active = { id, controller }
    try {
      this.running = this.run(id, controller.signal)
      await this.running
    } finally {
      this.running = null
      this.active = null
      this.progress.delete(id)
      void this.pump()
    }
  }

  private async run(id: string, signal: AbortSignal): Promise<void> {
    const item = this.store.exports().find((e) => e.id === id)
    if (!item) return
    // Stays "queued" (shown as waiting) until the best-of builder is free --
    // a full encode never runs at the same time as a best-of build.
    let release: (() => void) | null = null
    try {
      release = await this.encodeLock.acquire(signal)
      this.store.updateExport(id, { status: 'running', progress: 0, error: null, note: null })
      this.emit(id, true)
      const { file, note } = await this.render(item, signal, (f, eta) => {
        this.progress.set(id, { progress: f, etaSec: eta })
        this.emit(id)
      })
      this.store.updateExport(id, { status: 'done', progress: 1, file, note })
    } catch (err) {
      if (isCancelled(err)) {
        this.store.updateExport(id, { status: this.shuttingDown ? 'queued' : 'cancelled', progress: 0 })
      } else {
        log.error(`export ${id.slice(0, 8)} failed`, err)
        this.store.updateExport(id, { status: 'failed', error: userMessage(err, 'This clip could not be exported. Try again.') })
      }
    } finally {
      release?.()
    }
    this.progress.delete(id)
    this.emit(id, true)
  }

  private async getEncoder(ffmpeg: string): Promise<EncoderId> {
    if (this.encoder) return this.encoder
    const cached = this.store.get<{ encoder: EncoderId; gpu: string | null }>('encoder')
    const gpuName = this.hw().primary?.name ?? null
    if (cached && cached.gpu === gpuName) this.encoder = cached.encoder
    else {
      this.encoder = await chooseEncoder(ffmpeg, this.hw().primary?.vendor ?? null)
      this.store.set('encoder', { encoder: this.encoder, gpu: gpuName })
    }
    return this.encoder
  }

  /** Shared render deps, also used by the best-of joiner so both pick the same encoder. */
  private deps(): ClipRenderDeps {
    return {
      store: this.store,
      paths: this.paths,
      tools: this.tools,
      hw: this.hw,
      gpu: this.gpu,
      getEncoder: (ffmpeg) => this.getEncoder(ffmpeg),
      onHwEncoderFailed: () => this.notifyHwEncoderFailed()
    }
  }

  /** Counts a hardware-encoder failure; after enough of them, renders stick to libx264. Shared with the best-of joiner. */
  notifyHwEncoderFailed(): void {
    if (++this.hwFailures >= 2) {
      this.encoder = 'libx264'
      this.store.set('encoder', { encoder: 'libx264', gpu: this.hw().primary?.name ?? null })
    }
  }

  /** The encoder this PC uses for renders, probed and cached once. Shared with the best-of joiner. */
  async pickEncoder(): Promise<EncoderId> {
    return this.getEncoder(this.tools.require('ffmpeg'))
  }

  /**
   * Prepares one kept clip for the best-of joiner: everything its 16:9 export
   * does except the encode. Always the plain clip, never its automatic edit: a
   * per-clip loop ending, freeze or punch-in is built for a clip watched on
   * its own, and fights the best-of's own crossfade join between clips -- a
   * continuous reel reads better as one plain, steady cut from clip to clip.
   */
  async prepareForBestOf(clip: Clip, workDir: string, signal: AbortSignal, onProgress: (f: number) => void): Promise<BestOfPrepared> {
    return prepareClipForBestOf(this.deps(), clip, workDir, signal, onProgress)
  }

  /** Files already made for a clip in this go, by render signature: a platform whose file would come out the same copies one of them instead of encoding again. */
  private made = new Map<string, Map<string, string>>()

  /**
   * Renders one export item. The file is null (and the note says why) when the
   * platform was skipped for this clip; the note is also set when the clip was
   * cut at a phrase end to fit the platform's cap.
   */
  private async render(item: ExportItem, signal: AbortSignal, onProgress: (f: number, eta: number | null) => void): Promise<{ file: string | null; note: string | null }> {
    const found = this.store.clip(item.clipId)
    if (!found) throw new UserError('That clip no longer exists.', { retryable: false })
    const clip = await ensureClipNormalized(this.store, this.paths, found)
    const dir = jobDir(this.paths, item.jobId)
    const meta = await loadMeta(dir)

    const work = join(dir, 'render', item.id)
    const outDir = join(this.paths.output, safeFileName(`${meta.vod.channel} - ${meta.vod.title}`, 90))
    mkdirSync(outDir, { recursive: true })
    const partial = join(work, 'out.mp4')

    const files = this.made.get(clip.id) ?? new Map<string, string>()
    this.made.set(clip.id, files)
    try {
      const outcome = await renderClipToFile(this.deps(), clip, item.format, work, partial, signal, onProgress, {
        platform: item.platform,
        reuse: (signature) => files.get(signature) ?? null
      })
      if (outcome.kind === 'skipped') {
        rmSync(work, { recursive: true, force: true })
        log.info(`${item.platform ?? item.format} clip ${clip.rank}: left out`)
        return { file: null, note: outcome.note }
      }
      // Size, bars, sound, watermark and caption checks; may swap in a blur-fill re-render, throws only for a really broken clip.
      // A copy of a file that already passed them needs none.
      if (outcome.kind === 'rendered') await verifyExport(this.deps(), clip, item.format, item.platform, outcome.finalSec, work, partial, signal)

      const final = join(outDir, exportFileName(clip, item.format, item.platform, outcome.version))
      rmSync(final, { force: true })
      moveFile(partial, final)
      rmSync(work, { recursive: true, force: true })
      files.set(outcome.signature, final)
      log.info(`exported ${item.platform ?? item.format} clip ${clip.rank}${outcome.kind === 'copied' ? ' (same as an earlier platform, copied)' : ''}`)
      return { file: final, note: outcome.note }
    } finally {
      // Nothing more queued for this clip: forget its files.
      if (!this.queue.some((id) => this.store.exports().find((e) => e.id === id)?.clipId === clip.id)) this.made.delete(clip.id)
    }
  }
}
