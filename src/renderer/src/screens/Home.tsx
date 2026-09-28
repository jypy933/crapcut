import { AlertCircle, ArrowRight, Pause, Play, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useState, type FormEvent, type ReactNode } from 'react'
import { formatClock, formatEta } from '@shared/format'
import { STEP_IDS, STEP_LABELS, type JobSummary } from '@shared/types'
import { parseVodUrl } from '@shared/vodUrl'
import type { Route } from '../App'
import { call, errorText, useEvent } from '../api'
import { Spinner } from '../components/ui'

function upsert(list: JobSummary[], job: JobSummary): JobSummary[] {
  const i = list.findIndex((j) => j.id === job.id)
  if (i < 0) return [job, ...list]
  const next = [...list]
  next[i] = job
  return next
}

export function Home({ go }: { go: (r: Route) => void }): ReactNode {
  const [jobs, setJobs] = useState<JobSummary[] | null>(null)
  const [link, setLink] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    void call('jobs:list').then(setJobs)
  }, [])
  useEvent('jobs:changed', (job) => setJobs((l) => (l ? upsert(l, job) : [job])))

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
          placeholder="https://www.twitch.tv/videos/…"
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
            <JobCard key={j.id} job={j} go={go} />
          ))}
        </div>
      )}
    </div>
  )
}

function statusLine(job: JobSummary): ReactNode {
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
      return <span className="muted">Paused{step ? ` · ${STEP_LABELS[step].toLowerCase()}` : ''}</span>
    case 'cancelled':
      return <span className="faint">Stopped</span>
    case 'queued':
      return <span className="muted">Waiting for the job before it…</span>
    case 'running': {
      if (!step) return <span className="muted">Finishing…</span>
      const s = job.steps[step]
      const eta = formatEta(s.etaSec)
      return (
        <span className="muted">
          {STEP_LABELS[step]}
          {s.progress > 0.005 ? ` · ${Math.round(s.progress * 100)}%` : ''}
          {eta ? ` · ${eta} left` : ''}
          {s.detail ? <span className="faint"> · {s.detail}</span> : null}
        </span>
      )
    }
  }
}

function JobCard({ job, go }: { job: JobSummary; go: (r: Route) => void }): ReactNode {
  const [confirmDelete, setConfirmDelete] = useState(false)
  const title = job.vod?.title ?? `Twitch VOD ${job.vodId}`
  const sub = job.vod ? `${job.vod.channel} · ${formatClock(job.vod.durationSec)}` : 'Reading the VOD…'
  const running = job.status === 'running' || job.status === 'queued'

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
      <div className="small">{statusLine(job)}</div>
      {confirmDelete && <div className="small faint">Deletes this job’s downloads and clips from CrapCut. Exported videos stay in your Videos folder.</div>}
    </div>
  )
}

