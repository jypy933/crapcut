import { AlertCircle, Check, Circle, Cpu, Download } from 'lucide-react'
import type { ReactNode } from 'react'
import { formatBytes, formatEta } from '@shared/format'
import type { SetupStatus } from '@shared/types'
import { call } from '../api'
import { ProgressBar, Spinner } from '../components/ui'

function hardwareLine(s: SetupStatus): string {
  const hw = s.hardware
  if (!hw) return ''
  const gpu = hw.primary?.name ?? 'No graphics card found'
  const where = hw.whisper !== 'cpu' ? 'speech on the graphics card' : 'speech on the processor'
  return `${gpu} · ${where}`
}

export function Setup({ status }: { status: SetupStatus }): ReactNode {
  const total = status.components.reduce((s, c) => s + c.sizeBytes, 0)
  const done = status.components.reduce((s, c) => s + c.sizeBytes * (c.state === 'ready' ? 1 : c.progress), 0)
  const eta = formatEta(status.etaSec)
  const lowDisk = status.freeBytes !== null && status.freeBytes < status.remainingBytes * 1.5

  return (
    <div className="setup">
      <h1>Let's get CrapCut ready</h1>
      <p className="muted">
        CrapCut downloads the free tools and AI models it needs, once. Everything runs on this PC: no account, nothing uploaded.
      </p>

      <div className="row small faint" style={{ marginTop: 14 }}>
        <Cpu size={14} />
        <span>{hardwareLine(status)}</span>
      </div>

      <div className="card setup-list">
        {status.components.map((c) => (
          <div key={c.id} className="setup-item">
            <span>
              {c.state === 'ready' ? (
                <Check size={16} color="var(--good)" />
              ) : c.state === 'failed' ? (
                <AlertCircle size={16} color={c.optional ? 'var(--warn)' : 'var(--bad)'} />
              ) : c.state === 'missing' ? (
                <Circle size={14} color="var(--text-3)" />
              ) : (
                <Spinner />
              )}
            </span>
            <div className="grow">
              <div className="ellipsis">{c.label}</div>
              {(c.state === 'downloading' || c.state === 'verifying' || c.state === 'installing') && (
                <ProgressBar value={c.state === 'downloading' ? c.progress : 1} good={c.state !== 'downloading'} />
              )}
              {c.state === 'failed' && c.optional && <div className="small faint">Optional. CrapCut still works, clips just get simpler titles.</div>}
            </div>
            <span className="small faint" style={{ textAlign: 'right' }}>
              {c.state === 'verifying' ? 'Checking...' : c.state === 'installing' ? 'Installing...' : formatBytes(c.sizeBytes)}
            </span>
          </div>
        ))}
      </div>

      {status.running ? (
        <div className="col">
          <ProgressBar value={total ? done / total : 0} />
          <div className="row small muted">
            <span className="grow">
              {formatBytes(done)} of {formatBytes(total)}
              {eta ? ` · ${eta} left` : ''}
            </span>
            <button type="button" className="btn sm ghost" onClick={() => void call('setup:cancel')}>
              Pause
            </button>
          </div>
        </div>
      ) : (
        <div className="col">
          {status.error && (
            <div className="error">
              <AlertCircle size={15} style={{ flex: 'none', marginTop: 2 }} />
              {status.error}
            </div>
          )}
          <div className="row">
            <button type="button" className="btn primary big" onClick={() => void call('setup:start')}>
              <Download size={16} />
              {done > 0 ? 'Continue download' : 'Download'} ({formatBytes(status.remainingBytes)})
            </button>
            {status.freeBytes !== null && (
              <span className={`small ${lowDisk ? 'error' : 'faint'}`}>{formatBytes(status.freeBytes)} free on this drive</span>
            )}
          </div>
        </div>
      )}
      <p className="small faint" style={{ marginTop: 26 }}>
        Every file comes from its official source and is checked against a known fingerprint before use. If the download stops, it continues where it left off.
      </p>
    </div>
  )
}
