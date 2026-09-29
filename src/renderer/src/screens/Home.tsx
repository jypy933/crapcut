import { AlertCircle, ArrowRight, Pause, Play, Radio, RotateCcw, Trash2, X } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { formatClock, formatEta } from '@shared/format'
import { jobStepLine, summarizeWork, workLabel } from '@shared/progress'
import { STEP_IDS, STEP_LABELS, type ChannelWatchStatus, type JobSummary } from '@shared/types'
import { parseVodUrl } from '@shared/vodUrl'
import type { Route } from '../App'
import { call, errorText, useEvent } from '../api'
import { Spinner } from '../components/ui'
import { WorkLine } from '../components/WorkLine'
import { hasActiveWork, seen, useNow, type Work } from '../lib/work'

function upsert(list: JobSummary[], job: JobSummary): JobSummary[] {
  const i = list.findIndex((j) => j.id === job.id)
  if (i < 0) return [job, ...list]
  const next = [...list]
  next[i] = job
  return next
}

export function Home({ go, work }: { go: (r: Route) => void; work: Work }): ReactNode {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null)
  const [link, setLink] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void call('jobs:list').then(setJobs)
  }, [])
  useEvent('jobs:changed', (job) => setJobs((l) => (l ? upsert(l, job) : [job])))
  // A slow clock, only while something runs, so a time left that stopped updating drops away.
  const now = useNow(!!jobs?.some((j) => j.status === 'running') || hasActiveWork(work))

  async function submit(e: FormEvent): Promise<void> {
    e.preventDefault()
    const parsed = parseVodUrl(link)
    if (!parsed.ok) {
      setError(parsed.reason)
      return
    }
    setBusy(true)
    setError(null)
    try {
      const r = await call('jobs:create', link)
      if (!r.ok) setError(r.reason)
      else {
        setLink('')
        setJobs(await call('jobs:list'))
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="page">
      <h1>Turn a VOD into clips</h1>
      <p className="muted">Paste a link to a public Twitch VOD. CrapCut finds the best moments and cuts captioned clips.</p>
      <form className="paste" onSubmit={(e) => void submit(e)}>
        <input
          className="input big"
          placeholder="https://www.twitch.tv/videos/..."
          value={link}
          onChange={(e) => {
            setLink(e.target.value)
            setError(null)
          }}
          spellCheck={false}
          autoFocus
        />
        <button type="submit" className="btn primary big" disabled={busy || !link.trim()}>
          {busy ? <Spinner /> : null}
          Find clips
        </button>
      </form>
      {error && (
        <div className="error small">
          <AlertCircle size={14} style={{ flex: 'none', marginTop: 2 }} />
          {error}
        </div>
      )}

      <ChannelWatch />

      {jobs && jobs.length === 0 && (
        <div className="empty">
          {[
            ['Paste', 'a VOD link. Only the audio and chat are downloaded at first.'],
            ['Wait', 'while it listens to the stream and reads the chat. Long streams take a while.'],
            ['Review', 'the clips, tweak cuts and captions, then export for TikTok, Shorts and Reels.']
          ].map(([t, d], i) => (
            <div key={t} className="card">
              <div className="num">{i + 1}</div>
              <div style={{ fontWeight: 600, marginBottom: 4 }}>{t}</div>
              <div className="muted small">{d}</div>
            </div>
          ))}
        </div>
      )}

      {jobs && jobs.length > 0 && (
        <div className="jobs">
          {jobs.map((j) => (
            <JobCard key={j.id} job={j} go={go} now={now} work={{ exports: work.exports.filter((e) => e.jobId === j.id), bestOf: work.bestOf.filter((b) => b.jobId === j.id), seenAt: work.seenAt }} />
          ))}
        </div>
      )}
    </div>
  )
}

/** Small, out-of-the-way control to set or clear the one watched channel. */
function ChannelWatch(): ReactNode {
  const [status, setStatus] = useState<ChannelWatchStatus | null>(null)
  const [editing, setEditing] = useState(false)
  const [input, setInput] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void call('channelWatch:status').then(setStatus)
  }, [])
  useEvent('channelWatch:changed', setStatus)

  async function save(e: FormEvent): Promise<void> {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const r = await call('channelWatch:set', input)
      if (!r.ok) setError(r.reason)
      else {
        setInput('')
        setEditing(false)
      }
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  if (!status) return null

  if (status.channel) {
    return (
      <div className="row" style={{ marginTop: 14 }}>
        <Radio size={13} className="faint" style={{ flex: 'none' }} />
        <span className="small muted">
          Watching <strong>{status.channel}</strong> for new VODs
          {status.checking ? ' · checking now...' : status.lastError ? ` · ${status.lastError}` : ''}
        </span>
        <button type="button" className="btn sm ghost icon" title="Stop watching" onClick={() => void call('channelWatch:clear')}>
          <X size={13} />
        </button>
      </div>
    )
  }

  if (!editing) {
    return (
      <button type="button" className="btn sm ghost" style={{ marginTop: 14 }} onClick={() => setEditing(true)}>
        <Radio size={13} /> Watch a channel for new VODs
      </button>
    )
  }

  return (
    <form className="row" style={{ marginTop: 14 }} onSubmit={(e) => void save(e)}>
      <input
        className="input"
        style={{ width: 220 }}
        placeholder="channel name"
        value={input}
        onChange={(e) => {
          setInput(e.target.value)
          setError(null)
        }}
        spellCheck={false}
        autoFocus
      />
      <button type="submit" className="btn sm primary" disabled={busy || !input.trim()}>
        {busy ? <Spinner /> : null} Watch
      </button>
      <button type="button" className="btn sm ghost" onClick={() => setEditing(false)}>
        Cancel
      </button>
      {error && <span className="small error">{error}</span>}
    </form>
  )
}

function statusLine(job: JobSummary, now: number): ReactNode {
  const step = job.currentStep
  switch (job.status) {
    case 'review':
      return <span style={{ color: 'var(--good)' }}>{job.clipCount} clips ready to review</span>
    case 'failed':
      return (
        <span className="error">
          <AlertCircle size={14} style={{ flex: 'none', marginTop: 2 }} />
          {job.error ?? 'Something went wrong.'}
        </span>
      )
    case 'paused':
      return (
        <span className="muted">
          Paused{step ? ` · ${STEP_LABELS[step].toLowerCase()}` : ''}
          {step && job.steps[step].progress > 0.005 ? ` · ${Math.round(job.steps[step].progress * 100)}%` : ''}
        </span>
      )
    case 'cancelled':
      return <span className="faint">Stopped</span>
    case 'queued':
      return <span className="muted">Waiting for the job before it...</span>
    case 'running': {
      const line = jobStepLine(job, now)
      if (!line) return <span className="muted">Finishing...</span>
      const eta = formatEta(line.etaSec)
      return (
        <span className="muted">
          {line.step}
          {line.percent !== null ? ` · ${line.percent}%` : ''}
          {eta ? ` · ${eta} left` : ''}
          {line.detail ? <span className="faint"> · {line.detail}</span> : null}
        </span>
      )
    }
  }
}

function JobCard({ job, go, now, work }: { job: JobSummary; go: (r: Route) => void; now: number; work: Work }): ReactNode {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const title = job.vod?.title ?? `Twitch VOD ${job.vodId}`
  const sub = job.vod ? `${job.vod.channel} · ${formatClock(job.vod.durationSec)}` : 'Reading the VOD...'
  const running = job.status === 'running' || job.status === 'queued'
  const exporting = summarizeWork(seen(work.exports, work.seenAt), now)
  const building = summarizeWork(seen(work.bestOf, work.seenAt), now)

  return (
    <div className="card job">
      <div className="job-top">
        <div className="grow">
          <div className="ellipsis" style={{ fontWeight: 600, fontSize: 14 }}>
            {title}
          </div>
          <div className="small faint">{sub}</div>
        </div>
        <div className="row">
          {running && (
            <button type="button" className="btn sm ghost" onClick={() => void call('jobs:pause', job.id)} title="Pause">
              <Pause size={14} /> Pause
            </button>
          )}
          {(job.status === 'paused' || job.status === 'cancelled') && (
            <button type="button" className="btn sm" onClick={() => void call('jobs:resume', job.id)}>
              <Play size={14} /> Continue
            </button>
          )}
          {job.status === 'failed' && (
            <button type="button" className="btn sm" onClick={() => void call('jobs:resume', job.id)}>
              <RotateCcw size={14} /> Retry
            </button>
          )}
          {job.status === 'review' && (
            <button type="button" className="btn sm primary" onClick={() => go({ name: 'review', jobId: job.id })}>
              Review <ArrowRight size={14} />
            </button>
          )}
          {confirmDelete ? (
            <>
              <button type="button" className="btn sm danger" onClick={() => void call('jobs:delete', job.id)}>
                Delete for good
              </button>
              <button type="button" className="btn sm ghost" onClick={() => setConfirmDelete(false)}>
                Keep
              </button>
            </>
          ) : (
            <button type="button" className="btn sm ghost icon" title="Delete" onClick={() => setConfirmDelete(true)}>
              <Trash2 size={14} />
            </button>
          )}
        </div>
      </div>
      {job.status !== 'review' && (
        <div className="steps" aria-hidden>
          {STEP_IDS.map((s) => {
            const st = job.steps[s]
            const w = st.status === 'done' || st.status === 'skipped' ? 1 : st.status === 'running' || st.status === 'pending' ? st.progress : 0
            return (
              <div key={s} className={st.status === 'done' ? 'done' : st.status === 'failed' ? 'failed' : ''} title={STEP_LABELS[s]}>
                <div style={{ width: `${Math.round(w * 100)}%` }} />
              </div>
            )
          })}
        </div>
      )}
      <div className="small">{statusLine(job, now)}</div>
      {exporting && (
        <WorkLine
          label={workLabel('export', exporting)}
          fraction={exporting.fraction}
          etaSec={exporting.etaSec}
          started={exporting.running > 0}
          note={exporting.failed ? `${exporting.failed} could not be exported` : null}
        />
      )}
      {building && <WorkLine label={workLabel('bestOf', building)} fraction={building.fraction} etaSec={building.etaSec} started={building.running > 0} />}
      {confirmDelete && <div className="small faint">Deletes this job's downloads and clips from CrapCut. Exported videos stay in your Videos folder.</div>}
    </div>
  )
}

