// Export lane: renders accepted clips one at a time, separately from the
// analysis pipeline so reviewing and exporting never wait for a long job.

import { copyFileSync, existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { clipWords } from '@shared/captions'
import type { Clip, ExportFormat, ExportItem, HardwareProfile, Layout } from '@shared/types'
import { buildAss, CAPTION_FONT, defaultAssStyle } from '../core/ass'
import { EtaEstimator } from '../core/eta'
import { buildLoudnessMeasureArgs, buildRenderArgs, parseLoudnessMeasure, parseProgressSeconds, type AudioPlan, type EncoderId, type RenderSpec } from '../core/render'
import { jobDir, type AppPaths } from '../paths'
import type { Store } from '../store'
import { chooseEncoder } from '../tools/encoders'
import { runTool } from '../tools/process'
import type { ToolRegistry } from '../tools/registry'
import { UserError, isCancelled, userMessage } from '../util/errors'
import { moveFile } from '../util/fsx'
import { logger } from '../util/log'
import type { GpuLock } from './gpuLock'
import { probeMedia } from './media'
import { loadMeta } from './steps'
import { prepareStems } from './stems'

const log = logger('export')

export const DEFAULT_LAYOUT: Layout = { id: 'default-blur', name: 'Full frame', kind: 'blur_fill', cam: null, game: { x: 0, y: 0, w: 1, h: 1 } }

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
    private readonly events: ExporterEvents
  ) {}

  list(jobId?: string): ExportItem[] {
    return this.store.exports(jobId).map((e) => ({ ...e, ...(this.progress.get(e.id) ?? {}) }))
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
    this.store.updateExport(id, { status: 'running', progress: 0, error: null })
    this.emit(id, true)
    try {
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

  private async render(item: ExportItem, signal: AbortSignal, onProgress: (f: number, eta: number | null) => void): Promise<string> {
    const clip = this.store.clip(item.clipId)
    if (!clip) throw new UserError('That clip no longer exists.', { retryable: false })
    if (!clip.source) throw new UserError('The video for this clip has not been downloaded yet.', { retryable: false })
    const dir = jobDir(this.paths, item.jobId)
    const input = join(dir, 'clips', `${clip.id}.mp4`)
    if (!existsSync(input)) throw new UserError('The video for this clip is missing. Retry the job to download it again.', { retryable: false })
    const ffmpeg = this.tools.require('ffmpeg')
    const ffprobe = ffmpeg.replace(/ffmpeg\.exe$/i, 'ffprobe.exe')
    const media = await probeMedia(ffprobe, input, signal)
    const meta = await loadMeta(dir)

    const start = Math.max(clip.start, clip.source.start)
    const end = Math.min(clip.end, clip.source.end)
    const duration = end - start
    if (duration < 1) throw new UserError('This clip is too short to export.', { retryable: false })
    const seek = start - clip.source.start

    const work = join(dir, 'render', item.id)
    rmSync(work, { recursive: true, force: true })
    mkdirSync(join(work, 'fonts'), { recursive: true })
    copyFileSync(join(this.paths.resources, 'fonts', 'Montserrat-Black.ttf'), join(work, 'fonts', 'Montserrat-Black.ttf'))
    let assFile: string | null = null
    if (clip.captions.enabled) {
      const words = clipWords(clip.words, start, end)
      const y = item.format === 'vertical' ? clip.captions.y : Math.max(0.6, Math.min(0.92, clip.captions.y + 0.1))
      writeFileSync(join(work, 'captions.ass'), buildAss(words, { ...defaultAssStyle(item.format, y, clip.captions.uppercase), fontName: CAPTION_FONT }))
      assFile = 'captions.ass'
    }

    const layout = (clip.layoutId ? this.store.layout(clip.layoutId) : null) ?? DEFAULT_LAYOUT
    const eta = new EtaEstimator()

    // Audio: original, or stems for the voice options (separated only for this clip).
    let audio: AudioPlan = media.hasAudio ? { kind: 'original' } : { kind: 'silent' }
    let stemShare = 0
    if (media.hasAudio && clip.audio !== 'original') {
      stemShare = 0.4
      const stems = await prepareStems({
        ffmpeg,
        tools: this.tools,
        hw: this.hw(),
        gpu: this.gpu,
        input,
        seek,
        duration,
        workDir: work,
        signal,
        onProgress: (f) => onProgress(f * stemShare, null)
      })
      audio = {
        kind: 'stems',
        voice: stems.voice,
        game: clip.audio === 'voice_game' ? stems.background : null,
        gameGain: 0.3,
        music: clip.audio === 'voice_music' ? clip.musicPath : null,
        musicGain: 0.22
      }
      if (clip.audio === 'voice_music' && !clip.musicPath) throw new UserError('Pick a music file for this clip first.', { retryable: false })
    }

    let loudness = null
    if (audio.kind === 'original') {
      const measured = await runTool(ffmpeg, buildLoudnessMeasureArgs(input, seek, duration), { signal }).catch((err) => {
        if (isCancelled(err)) throw err
        return null
      })
      loudness = measured ? parseLoudnessMeasure(measured.stderr) : null
    }

    const outDir = join(this.paths.output, safeFileName(`${meta.vod.channel} - ${meta.vod.title}`, 90))
    mkdirSync(outDir, { recursive: true })
    const final = join(outDir, exportFileName(clip, item.format))
    const partial = join(work, 'out.mp4')

    const spec = (encoder: EncoderId): RenderSpec => ({
      input,
      seek,
      duration,
      source: { width: media.width, height: media.height },
      sourceFps: media.fps,
      format: item.format,
      layout,
      assFile,
      fontsDir: 'fonts',
      audio,
      loudness,
      encoder,
      output: partial
    })

    const encode = async (encoder: EncoderId): Promise<void> => {
      await runTool(ffmpeg, buildRenderArgs(spec(encoder)), {
        cwd: work,
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

    const encoder = await this.getEncoder(ffmpeg)
    try {
      await encode(encoder)
    } catch (err) {
      if (isCancelled(err) || encoder === 'libx264') throw err
      log.warn(`${encoder} failed; retrying with libx264`, err)
      if (++this.hwFailures >= 2) {
        this.encoder = 'libx264'
        this.store.set('encoder', { encoder: 'libx264', gpu: this.hw().primary?.name ?? null })
      }
      await encode('libx264')
    }

    rmSync(final, { force: true })
    moveFile(partial, final)
    rmSync(work, { recursive: true, force: true })
    log.info(`exported ${item.format} clip ${clip.rank}`)
    return final
  }
}
