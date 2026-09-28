// Durable state in SQLite (Node's built-in node:sqlite, no native modules).
// Jobs, their per-step checkpoints, clips, layouts, exports and small settings.
// Large data (audio, transcript, chat) lives in files in each job's folder.

import { DatabaseSync } from 'node:sqlite'
import { randomUUID } from 'node:crypto'
import {
  STEP_IDS,
  type BestOfItem,
  type Clip,
  type ExportItem,
  type JobStatus,
  type JobSummary,
  type Layout,
  type StepId,
  type StepState,
  type VodInfo
} from '@shared/types'
import type { TasteDecision } from './core/taste'

const SCHEMA_VERSION = 2

/** Exported so tests can build a real "database from an older version" without duplicating the SQL. */
export const MIGRATIONS: Record<number, string> = {
  1: `
    CREATE TABLE jobs (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      vod_id TEXT NOT NULL,
      vod TEXT,
      status TEXT NOT NULL,
      error TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE steps (
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      step TEXT NOT NULL,
      status TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0,
      eta_sec INTEGER,
      detail TEXT,
      PRIMARY KEY (job_id, step)
    );
    CREATE TABLE clips (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      rank INTEGER NOT NULL,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX clips_job ON clips(job_id, rank);
    CREATE TABLE layouts (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE exports (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      clip_id TEXT NOT NULL,
      format TEXT NOT NULL,
      status TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0,
      file TEXT,
      error TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE kv (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `,
  2: `
    CREATE TABLE best_of (
      id TEXT PRIMARY KEY,
      job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      progress REAL NOT NULL DEFAULT 0,
      file TEXT,
      error TEXT,
      created_at INTEGER NOT NULL
    );
  `
}

const EXPORT_COLUMNS = new Set(['status', 'progress', 'file', 'error'])
const BEST_OF_COLUMNS = new Set(['status', 'progress', 'file', 'error'])

/** One review decision kept for taste learning, stored in the `kv` table. */
interface StoredTasteDecision extends TasteDecision {
  clipId: string
  decidedAt: number
}

const TASTE_HISTORY_KEY = 'tasteHistory'
/** Old decisions matter less than recent ones and the list must stay small. */
const TASTE_HISTORY_MAX = 500

const emptyStep = (): StepState => ({ status: 'pending', progress: 0, etaSec: null, detail: null })

interface JobRow {
  id: string
  url: string
  vod_id: string
  vod: string | null
  status: string
  error: string | null
  created_at: number
  updated_at: number
}

interface StepRow {
  step: string
  status: string
  progress: number
  eta_sec: number | null
  detail: string | null
}

export class Store {
  readonly db: DatabaseSync

  constructor(file: string) {
    this.db = new DatabaseSync(file)
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;')
    this.migrate()
  }

  close(): void {
    this.db.close()
  }

  private migrate(): void {
    const row = this.db.prepare('PRAGMA user_version').get() as { user_version: number }
    for (let v = row.user_version + 1; v <= SCHEMA_VERSION; v++) {
      this.db.exec('BEGIN')
      try {
        this.db.exec(MIGRATIONS[v]!)
        this.db.exec(`PRAGMA user_version = ${v}`)
        this.db.exec('COMMIT')
      } catch (err) {
        this.db.exec('ROLLBACK')
        throw err
      }
    }
  }

  private tx<T>(fn: () => T): T {
    this.db.exec('BEGIN')
    try {
      const r = fn()
      this.db.exec('COMMIT')
      return r
    } catch (err) {
      this.db.exec('ROLLBACK')
      throw err
    }
  }

  // ---- jobs ----

  createJob(url: string, vodId: string): string {
    const id = randomUUID()
    const now = Date.now()
    this.tx(() => {
      this.db.prepare('INSERT INTO jobs (id, url, vod_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, url, vodId, 'queued', now, now)
      const ins = this.db.prepare('INSERT INTO steps (job_id, step, status) VALUES (?, ?, ?)')
      for (const s of STEP_IDS) ins.run(id, s, 'pending')
    })
    return id
  }

  findActiveJobForVod(vodId: string): string | null {
    const row = this.db.prepare("SELECT id FROM jobs WHERE vod_id = ? AND status NOT IN ('cancelled') ORDER BY created_at DESC LIMIT 1").get(vodId) as
      | { id: string }
      | undefined
    return row?.id ?? null
  }

  job(id: string): JobSummary | null {
    const row = this.db.prepare('SELECT * FROM jobs WHERE id = ?').get(id) as JobRow | undefined
    return row ? this.toSummary(row) : null
  }

  jobs(): JobSummary[] {
    const rows = this.db.prepare('SELECT * FROM jobs ORDER BY created_at DESC').all() as unknown as JobRow[]
    return rows.map((r) => this.toSummary(r))
  }

  private toSummary(row: JobRow): JobSummary {
    const steps = Object.fromEntries(STEP_IDS.map((s) => [s, emptyStep()])) as Record<StepId, StepState>
    const stepRows = this.db.prepare('SELECT step, status, progress, eta_sec, detail FROM steps WHERE job_id = ?').all(row.id) as unknown as StepRow[]
    for (const s of stepRows) {
      if ((STEP_IDS as readonly string[]).includes(s.step)) {
        steps[s.step as StepId] = { status: s.status as StepState['status'], progress: s.progress, etaSec: s.eta_sec, detail: s.detail }
      }
    }
    const currentStep = STEP_IDS.find((s) => steps[s].status !== 'done' && steps[s].status !== 'skipped') ?? null
    const clipCount = (this.db.prepare('SELECT COUNT(*) AS n FROM clips WHERE job_id = ?').get(row.id) as { n: number }).n
    return {
      id: row.id,
      url: row.url,
      vodId: row.vod_id,
      vod: row.vod ? (JSON.parse(row.vod) as VodInfo) : null,
      status: row.status as JobStatus,
      currentStep,
      steps,
      error: row.error,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      clipCount
    }
  }

  setJobStatus(id: string, status: JobStatus, error: string | null = null): void {
    this.db.prepare('UPDATE jobs SET status = ?, error = ?, updated_at = ? WHERE id = ?').run(status, error, Date.now(), id)
  }

  setVod(id: string, vod: VodInfo): void {
    this.db.prepare('UPDATE jobs SET vod = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(vod), Date.now(), id)
  }

  setStep(jobId: string, step: StepId, patch: Partial<StepState>): void {
    const sets: string[] = []
    const vals: (string | number | null)[] = []
    if (patch.status !== undefined) (sets.push('status = ?'), vals.push(patch.status))
    if (patch.progress !== undefined) (sets.push('progress = ?'), vals.push(Math.max(0, Math.min(1, patch.progress))))
    if (patch.etaSec !== undefined) (sets.push('eta_sec = ?'), vals.push(patch.etaSec))
    if (patch.detail !== undefined) (sets.push('detail = ?'), vals.push(patch.detail))
    if (sets.length === 0) return
    this.db.prepare(`UPDATE steps SET ${sets.join(', ')} WHERE job_id = ? AND step = ?`).run(...vals, jobId, step)
    this.db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(Date.now(), jobId)
  }

  /** Marks a step and every later step as pending again (for "find again"). */
  resetStepsFrom(jobId: string, step: StepId): void {
    const idx = STEP_IDS.indexOf(step)
    const stmt = this.db.prepare("UPDATE steps SET status = 'pending', progress = 0, eta_sec = NULL, detail = NULL WHERE job_id = ? AND step = ?")
    for (const s of STEP_IDS.slice(idx)) stmt.run(jobId, s)
  }

  deleteJob(id: string): void {
    this.db.prepare('DELETE FROM jobs WHERE id = ?').run(id)
  }

  /** Jobs that were running when the app closed; they wait for "Continue". */
  markInterruptedJobs(): string[] {
    const rows = this.db.prepare("SELECT id FROM jobs WHERE status IN ('running', 'queued')").all() as { id: string }[]
    for (const r of rows) {
      this.setJobStatus(r.id, 'paused')
      this.db.prepare("UPDATE steps SET status = 'pending', eta_sec = NULL WHERE job_id = ? AND status = 'running'").run(r.id)
    }
    return rows.map((r) => r.id)
  }

  // ---- clips ----

  replaceClips(jobId: string, clips: Clip[]): void {
    this.tx(() => {
      this.db.prepare('DELETE FROM clips WHERE job_id = ?').run(jobId)
      const ins = this.db.prepare('INSERT INTO clips (id, job_id, rank, data, updated_at) VALUES (?, ?, ?, ?, ?)')
      for (const c of clips) ins.run(c.id, jobId, c.rank, JSON.stringify(c), Date.now())
    })
  }

  clips(jobId: string): Clip[] {
    const rows = this.db.prepare('SELECT data FROM clips WHERE job_id = ? ORDER BY rank').all(jobId) as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as Clip)
  }

  clip(id: string): Clip | null {
    const row = this.db.prepare('SELECT data FROM clips WHERE id = ?').get(id) as { data: string } | undefined
    return row ? (JSON.parse(row.data) as Clip) : null
  }

  saveClip(clip: Clip): void {
    this.db.prepare('UPDATE clips SET data = ?, rank = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(clip), clip.rank, Date.now(), clip.id)
  }

  // ---- layouts ----

  layouts(): Layout[] {
    const rows = this.db.prepare('SELECT data FROM layouts ORDER BY updated_at DESC').all() as { data: string }[]
    return rows.map((r) => JSON.parse(r.data) as Layout)
  }

  layout(id: string): Layout | null {
    const row = this.db.prepare('SELECT data FROM layouts WHERE id = ?').get(id) as { data: string } | undefined
    return row ? (JSON.parse(row.data) as Layout) : null
  }

  saveLayout(layout: Layout): void {
    this.db
      .prepare('INSERT INTO layouts (id, data, updated_at) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at')
      .run(layout.id, JSON.stringify(layout), Date.now())
  }

  deleteLayout(id: string): void {
    this.db.prepare('DELETE FROM layouts WHERE id = ?').run(id)
  }

  // ---- exports ----

  addExport(jobId: string, clipId: string, format: ExportItem['format']): string {
    const id = randomUUID()
    this.db.prepare('INSERT INTO exports (id, job_id, clip_id, format, status, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(id, jobId, clipId, format, 'queued', Date.now())
    return id
  }

  exports(jobId?: string): ExportItem[] {
    const rows = (
      jobId
        ? this.db.prepare('SELECT * FROM exports WHERE job_id = ? ORDER BY created_at').all(jobId)
        : this.db.prepare('SELECT * FROM exports ORDER BY created_at').all()
    ) as { id: string; job_id: string; clip_id: string; format: string; status: string; progress: number; file: string | null; error: string | null; created_at: number }[]
    return rows.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      clipId: r.clip_id,
      format: r.format as ExportItem['format'],
      status: r.status as ExportItem['status'],
      progress: r.progress,
      etaSec: null,
      file: r.file,
      error: r.error,
      createdAt: r.created_at
    }))
  }

  updateExport(id: string, patch: Partial<Pick<ExportItem, 'status' | 'progress' | 'file' | 'error'>>): void {
    const sets: string[] = []
    const vals: (string | number | null)[] = []
    for (const [k, v] of Object.entries(patch)) {
      if (!EXPORT_COLUMNS.has(k)) continue
      sets.push(`${k} = ?`)
      vals.push(v as string | number | null)
    }
    if (sets.length) this.db.prepare(`UPDATE exports SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
  }

  /** Exports cut short by a crash go back to the queue. */
  requeueInterruptedExports(): void {
    this.db.prepare("UPDATE exports SET status = 'queued', progress = 0 WHERE status = 'running'").run()
  }

  // ---- best-of ----

  addBestOf(jobId: string): string {
    const id = randomUUID()
    this.db.prepare('INSERT INTO best_of (id, job_id, status, created_at) VALUES (?, ?, ?, ?)').run(id, jobId, 'queued', Date.now())
    return id
  }

  bestOfList(jobId?: string): BestOfItem[] {
    const rows = (
      jobId
        ? this.db.prepare('SELECT * FROM best_of WHERE job_id = ? ORDER BY created_at').all(jobId)
        : this.db.prepare('SELECT * FROM best_of ORDER BY created_at').all()
    ) as { id: string; job_id: string; status: string; progress: number; file: string | null; error: string | null; created_at: number }[]
    return rows.map((r) => ({
      id: r.id,
      jobId: r.job_id,
      status: r.status as BestOfItem['status'],
      progress: r.progress,
      etaSec: null,
      file: r.file,
      error: r.error,
      createdAt: r.created_at
    }))
  }

  updateBestOf(id: string, patch: Partial<Pick<BestOfItem, 'status' | 'progress' | 'file' | 'error'>>): void {
    const sets: string[] = []
    const vals: (string | number | null)[] = []
    for (const [k, v] of Object.entries(patch)) {
      if (!BEST_OF_COLUMNS.has(k)) continue
      sets.push(`${k} = ?`)
      vals.push(v as string | number | null)
    }
    if (sets.length) this.db.prepare(`UPDATE best_of SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id)
  }

  /** Builds cut short by a crash go back to the queue. */
  requeueInterruptedBestOf(): void {
    this.db.prepare("UPDATE best_of SET status = 'queued', progress = 0 WHERE status = 'running'").run()
  }

  // ---- settings ----

  get<T>(key: string): T | null {
    const row = this.db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined
    return row ? (JSON.parse(row.value) as T) : null
  }

  set(key: string, value: unknown): void {
    this.db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, JSON.stringify(value))
  }

  // ---- taste history ----

  getTasteHistory(): TasteDecision[] {
    return this.get<StoredTasteDecision[]>(TASTE_HISTORY_KEY) ?? []
  }

  /** Records (or clears) the review decision for one clip, keyed by clip id. */
  recordTasteDecision(clipId: string, decision: TasteDecision | null): void {
    const all = this.get<StoredTasteDecision[]>(TASTE_HISTORY_KEY) ?? []
    const next = all.filter((d) => d.clipId !== clipId)
    if (decision) next.push({ ...decision, clipId, decidedAt: Date.now() })
    while (next.length > TASTE_HISTORY_MAX) next.shift()
    this.set(TASTE_HISTORY_KEY, next)
  }

  clearTasteHistory(): void {
    this.set(TASTE_HISTORY_KEY, [])
  }
}
