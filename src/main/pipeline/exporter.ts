// Export lane: renders accepted clips one at a time, separately from the
// analysis pipeline so reviewing and exporting never wait for a long job.

import { mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
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
import { DEFAULT_LAYOUT, renderClipToFile, type ClipRenderDeps } from './clipRender'
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

export function exportFileName(clip: Clip, format: ExportFormat): string {
  const tag = format === 'vertical' ? '9x16' : '16x9'
  return `${String(clip.rank).padStart(2, '0')} ${safeFileName(clip.title, 60)} (${tag}).mp4`
}

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

  /** Queues exports for the given clips in each format they have ticked. */
  add(jobId: string, clipIds: string[]): string[] {
    const ids: string[] = []
    for (const clipId of clipIds) {
      const clip = this.store.clip(clipId)
      if (!clip || clip.jobId !== jobId) continue
      const formats: ExportFormat[] = []
      if (clip.formats.vertical) formats.push('vertical')
      if (clip.formats.horizontal) formats.push('horizontal')
      for (const f of formats) {
        const id = this.store.addExport(jobId, clipId, f)
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
      this.store.updateExport(id, { status: 'running', progress: 0, error: null })
      this.emit(id, true)
      const file = await this.render(item, signal, (f, eta) => {
        this.progress.set(id, { progress: f, etaSec: eta })
        this.emit(id)
      })
      this.store.updateExport(id, { status: 'done', progress: 1, file })
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
   * Renders one kept clip as 16:9 to an arbitrary file, for the best-of
   * joiner. Always the plain clip, never its automatic edit: a per-clip loop
   * ending, freeze or punch-in is built for a clip watched on its own, and
   * fights the best-of's own crossfade join between clips -- a continuous
   * reel reads better as one plain, steady cut from clip to clip.
   */
  async renderForBestOf(clip: Clip, workDir: string, outputPath: string, signal: AbortSignal, onProgress: (f: number, etaSec: number | null) => void): Promise<void> {
    await renderClipToFile(this.deps(), { ...clip, autoEdit: false }, 'horizontal', workDir, outputPath, signal, onProgress)
  }

  private async render(item: ExportItem, signal: AbortSignal, onProgress: (f: number, eta: number | null) => void): Promise<string> {
    const found = this.store.clip(item.clipId)
    if (!found) throw new UserError('That clip no longer exists.', { retryable: false })
    const clip = await ensureClipNormalized(this.store, this.paths, found)
    const dir = jobDir(this.paths, item.jobId)
    const meta = await loadMeta(dir)

    const work = join(dir, 'render', item.id)
    const outDir = join(this.paths.output, safeFileName(`${meta.vod.channel} - ${meta.vod.title}`, 90))
    mkdirSync(outDir, { recursive: true })
    const final = join(outDir, exportFileName(clip, item.format))
    const partial = join(work, 'out.mp4')

    await renderClipToFile(this.deps(), clip, item.format, work, partial, signal, onProgress)

    rmSync(final, { force: true })
    moveFile(partial, final)
    rmSync(work, { recursive: true, force: true })
    log.info(`exported ${item.format} clip ${clip.rank}`)
    return final
  }
}
