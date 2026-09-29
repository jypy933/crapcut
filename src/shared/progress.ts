// Pure helpers that turn job, export and best-of state into what the UI (and
// the Windows taskbar) shows: one status line per row and one overall bar.

import { STEP_IDS, STEP_LABELS, type BestOfItem, type ExportItem, type JobSummary, type StepId } from './types'

/** A time left that was not refreshed for this long is stale (the work has stalled) and is hidden. */
export const STALE_ETA_MS = 45_000

/** Seconds left, or null when unknown or when nothing has updated it lately. */
export function freshEta(etaSec: number | null, updatedAt: number, now: number): number | null {
  return etaSec !== null && now - updatedAt <= STALE_ETA_MS ? etaSec : null
}

/** Roughly how much of a whole job each step is, so one bar can run across all of them. */
const STEP_WEIGHTS: Record<StepId, number> = {
  metadata: 1,
  chat: 4,
  audio: 12,
  transcribe: 40,
  moments: 20,
  clipCaptions: 8,
  clips: 15
}

/** 0..1 across the whole job, weighting each step by how long it usually takes. */
export function jobFraction(job: Pick<JobSummary, 'steps'>): number {
  let done = 0
  let total = 0
  for (const id of STEP_IDS) {
    const s = job.steps[id]
    const w = STEP_WEIGHTS[id]
    total += w
    if (s.status === 'done' || s.status === 'skipped') done += w
    else if (s.status === 'running' || s.status === 'pending') done += w * Math.max(0, Math.min(1, s.progress))
  }
  return done / total
}

export interface JobStepLine {
  step: string
  /** Whole percent of this step, or null before it has really started. */
  percent: number | null
  etaSec: number | null
  /** Extra plain words, e.g. "Clip 3 of 12". */
  detail: string | null
}

/** Where a running job is right now, for its one status line. Null when it is not running a step. */
export function jobStepLine(job: JobSummary, now: number): JobStepLine | null {
  const id = job.currentStep
  if (job.status !== 'running' || !id) return null
  const s = job.steps[id]
  return {
    step: STEP_LABELS[id],
    percent: s.progress > 0.005 ? Math.round(s.progress * 100) : null,
    etaSec: freshEta(s.etaSec, job.updatedAt, now),
    detail: s.detail?.trim() || null
  }
}

type WorkItem = Pick<ExportItem | BestOfItem, 'status' | 'progress' | 'etaSec' | 'createdAt'> & {
  /** When the UI last heard about this item (epoch ms); its time left goes stale like a job's. */
  seenAt?: number
}

export interface WorkSummary {
  /** Items in the batch that are still wanted (finished, running or waiting). */
  total: number
  done: number
  running: number
  queued: number
  failed: number
  /** 0..1 across the batch. */
  fraction: number
  /** Seconds left for the whole batch, or null when it cannot be said honestly. */
  etaSec: number | null
}

/** Exports made in one go are created within moments of each other. */
const BATCH_SLACK_MS = 5000

/**
 * The batch of exports (or best-of builds) that is under way: everything
 * queued or running, plus what finished from the same go. Null when nothing is
 * queued or running. Cancelled items and earlier, older batches are left out.
 */
export function summarizeWork(items: readonly WorkItem[], now?: number): WorkSummary | null {
  const active = items.filter((i) => i.status === 'queued' || i.status === 'running')
  if (active.length === 0) return null
  const since = Math.min(...active.map((i) => i.createdAt)) - BATCH_SLACK_MS
  const batch = items.filter((i) => i.status !== 'cancelled' && i.createdAt >= since)
  const running = batch.filter((i) => i.status === 'running')
  const queued = batch.filter((i) => i.status === 'queued').length
  const done = batch.filter((i) => i.status === 'done').length
  const failed = batch.filter((i) => i.status === 'failed').length
  const partial = running.reduce((sum, i) => sum + Math.max(0, Math.min(1, i.progress)), 0)
  return {
    total: batch.length,
    done,
    running: running.length,
    queued,
    failed,
    fraction: Math.min(1, (done + failed + partial) / batch.length),
    etaSec: running.length === 1 ? batchEta(running[0]!, queued, now) : null
  }
}

/** An item needs to be this far along before its pace says much about the items waiting behind it. */
const MIN_PACE_PROGRESS = 0.1

/**
 * Time left for the running item plus every waiting one, assuming they take as
 * long as this one does in total (its time left over the share it still has to
 * do). Null when the running item has no fresh time left, or it is too early
 * in it to judge the rest by.
 */
function batchEta(running: WorkItem, queued: number, now?: number): number | null {
  const eta = running.seenAt !== undefined && now !== undefined ? freshEta(running.etaSec, running.seenAt, now) : running.etaSec
  if (eta === null) return null
  if (queued === 0) return eta
  if (running.progress < MIN_PACE_PROGRESS || running.progress >= 1) return null
  return Math.round(eta + (queued * eta) / (1 - running.progress))
}

/** "Exporting clip 2 of 5", "Building the best-of video"; waiting wording while nothing has started. */
export function workLabel(kind: 'export' | 'bestOf', s: WorkSummary): string {
  if (kind === 'bestOf') return s.running > 0 ? 'Building the best-of video' : 'Waiting to build the best-of video'
  if (s.running === 0) return s.total > 1 ? 'Waiting to export' : 'Waiting to export the clip'
  return s.total > 1 ? `Exporting clip ${Math.min(s.total, s.done + s.failed + 1)} of ${s.total}` : 'Exporting the clip'
}
