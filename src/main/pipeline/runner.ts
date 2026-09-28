// Runs jobs one at a time through the pipeline steps, with checkpoints,
// pause/continue, cancel, automatic retries for network hiccups and a
// disk-space check before starting.

import { mkdirSync, rmSync } from 'node:fs'
import { STEP_IDS, STEP_LABELS, type HardwareProfile, type JobSummary, type StepId } from '@shared/types'
import { EtaEstimator } from '../core/eta'
import { jobDir, type AppPaths } from '../paths'
import type { Store } from '../store'
import { freeBytes } from '../tools/setup'
import type { ToolRegistry } from '../tools/registry'
import { UserError, isCancelled, userMessage } from '../util/errors'
import { logger } from '../util/log'
import type { GpuLock } from './gpuLock'
import { NETWORK_STEPS, STEPS, type StepContext } from './steps'

const log = logger('runner')

const MAX_AUTO_RETRIES = 3

/** Rough disk space a job needs: audio + a temporary WAV + clip video. */
export function estimateJobBytes(durationSec: number): number {
  const audio = durationSec * 26_000
  const wav = durationSec * 32_000
  const clips = 20 * 80 * 1_000_000
  return Math.round(audio + wav + clips + 500_000_000)
}

type StopReason = 'pause' | 'cancel' | 'delete'

export interface RunnerEvents {
  onJobChanged: (job: JobSummary) => void
  onJobReady: (job: JobSummary) => void
}

export class JobRunner {
  private queue: string[] = []
  private active: { id: string; controller: AbortController; reason: StopReason | null } | null = null
  private lastEmit = new Map<string, number>()

  constructor(
    private readonly store: Store,
    private readonly paths: AppPaths,
    private readonly tools: ToolRegistry,
    private readonly hw: () => HardwareProfile,
    private readonly gpu: GpuLock,
    private readonly events: RunnerEvents,
    private readonly options: { llmModelOverride?: string } = {}
  ) {}

  private emit(id: string, force = false): void {
    const now = Date.now()
    if (!force && now - (this.lastEmit.get(id) ?? 0) < 250) return
    this.lastEmit.set(id, now)
    const job = this.store.job(id)
    if (job) this.events.onJobChanged(job)
  }

  isActive(id: string): boolean {
    return this.active?.id === id || this.queue.includes(id)
  }

  enqueue(id: string): void {
    if (this.isActive(id)) return
    const job = this.store.job(id)
    if (!job) return
    // A failed step becomes pending again so it is retried.
    for (const s of STEP_IDS) if (job.steps[s].status === 'failed') this.store.setStep(id, s, { status: 'pending', detail: null })
    this.store.setJobStatus(id, 'queued')
    this.queue.push(id)
    this.emit(id, true)
    void this.pump()
  }

  pause(id: string): void {
    this.stop(id, 'pause')
  }

  cancel(id: string): void {
    this.stop(id, 'cancel')
  }

  /** Stops the job if running and deletes it with all its files. */
  delete(id: string): void {
    this.stop(id, 'delete')
    this.store.deleteJob(id)
    rmSync(jobDir(this.paths, id), { recursive: true, force: true })
  }

  private stop(id: string, reason: StopReason): void {
    const queued = this.queue.indexOf(id)
    if (queued >= 0) {
      this.queue.splice(queued, 1)
      if (reason !== 'delete') this.store.setJobStatus(id, reason === 'pause' ? 'paused' : 'cancelled')
      this.emit(id, true)
    }
    if (this.active?.id === id) {
      this.active.reason = reason
      this.active.controller.abort()
    }
  }

  private running: Promise<void> | null = null

  /** Pauses whatever is running (used when the app closes). */
  async shutdown(): Promise<void> {
    for (const id of [...this.queue]) this.stop(id, 'pause')
    if (this.active) this.stop(this.active.id, 'pause')
    await this.running
  }

  private async pump(): Promise<void> {
    if (this.active) return
    const id = this.queue.shift()
    if (!id) return
    const controller = new AbortController()
    this.active = { id, controller, reason: null }
    try {
      this.running = this.run(id, controller.signal)
      await this.running
    } finally {
      this.running = null
      this.active = null
      void this.pump()
    }
  }

  private async run(id: string, signal: AbortSignal): Promise<void> {
    const dir = jobDir(this.paths, id)
    mkdirSync(dir, { recursive: true })
    this.store.setJobStatus(id, 'running')
    this.emit(id, true)

    const job0 = this.store.job(id)
    if (!job0) return
    if (job0.vod) {
      const free = await freeBytes(this.paths.root)
      if (free !== null && free < estimateJobBytes(job0.vod.durationSec) * 0.5) {
        this.store.setJobStatus(id, 'failed', 'Not enough free disk space for this VOD. Free a few GB and try again.')
        this.emit(id, true)
        return
      }
    }

    for (const step of STEP_IDS) {
      const job = this.store.job(id)
      if (!job) return
      if (job.steps[step].status === 'done' || job.steps[step].status === 'skipped') continue
      const ok = await this.runStep(job, step, dir, signal)
      if (!ok) return
    }
    this.store.setJobStatus(id, 'review')
    const done = this.store.job(id)
    this.emit(id, true)
    if (done) this.events.onJobReady(done)
  }

  /** Runs one step with retries. Returns false when the job should stop. */
  private async runStep(job: JobSummary, step: StepId, dir: string, signal: AbortSignal): Promise<boolean> {
    const id = job.id
    const eta = new EtaEstimator()
    for (let attempt = 0; ; attempt++) {
      this.store.setStep(id, step, { status: 'running', etaSec: null, detail: null })
      this.emit(id, true)
      eta.reset()
      const ctx: StepContext = {
        job,
        dir,
        paths: this.paths,
        store: this.store,
        tools: this.tools,
        hw: this.hw(),
        gpu: this.gpu,
        signal,
        llmModelOverride: this.options.llmModelOverride,
        log: logger(`job ${id.slice(0, 8)} ${step}`),
        progress: (fraction, detail) => {
          const f = Math.max(0, Math.min(1, fraction))
          this.store.setStep(id, step, { progress: f, etaSec: eta.update(f, 1), ...(detail !== undefined ? { detail } : {}) })
          this.emit(id)
        }
      }
      try {
        const started = Date.now()
        await STEPS[step](ctx)
        this.store.setStep(id, step, { status: 'done', progress: 1, etaSec: null, detail: null })
        log.info(`${id.slice(0, 8)} ${step} done in ${Math.round((Date.now() - started) / 1000)} s`)
        this.emit(id, true)
        return true
      } catch (err) {
        if (isCancelled(err) || signal.aborted) {
          const reason = this.active?.reason ?? 'pause'
          this.store.setStep(id, step, { status: 'pending', etaSec: null, detail: null })
          if (reason !== 'delete') this.store.setJobStatus(id, reason === 'cancel' ? 'cancelled' : 'paused')
          this.emit(id, true)
          return false
        }
        const retryable = !(err instanceof UserError) || err.retryable
        if (retryable && NETWORK_STEPS.has(step) && attempt < MAX_AUTO_RETRIES) {
          log.warn(`${id.slice(0, 8)} ${step} failed (attempt ${attempt + 1}), retrying`, err)
          this.store.setStep(id, step, { detail: 'Connection problem, retrying…' })
          this.emit(id, true)
          const wait = 5000 * 2 ** attempt
          // Wait, but wake up at once if the user pauses (the next attempt then stops cleanly).
          await new Promise<void>((resolve) => {
            const t = setTimeout(resolve, wait)
            signal.addEventListener('abort', () => (clearTimeout(t), resolve()), { once: true })
          })
          continue
        }
        log.error(`${id.slice(0, 8)} ${step} failed`, err)
        const message = userMessage(err, `Something went wrong while ${STEP_LABELS[step].toLowerCase()}. You can retry.`)
        this.store.setStep(id, step, { status: 'failed', etaSec: null, detail: null })
        this.store.setJobStatus(id, 'failed', message)
        this.emit(id, true)
        return false
      }
    }
  }
}
