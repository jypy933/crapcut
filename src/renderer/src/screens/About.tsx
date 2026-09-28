import { Download, FileText, FolderOpen, RefreshCw, RotateCcw } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import type { AppInfo, UpdateState } from '@shared/types'
import { call } from '../api'
import { Spinner } from '../components/ui'

function updateLine(u: UpdateState): string {
  switch (u.kind) {
    case 'checking':
      return 'Checking for updates...'
    case 'available':
      return `Version ${u.version} is available, downloading...`
    case 'downloading':
      return `Downloading update... ${Math.round(u.progress * 100)}%`
    case 'ready':
      return `Version ${u.version} is ready. Restart to update.`
    case 'none':
      return 'You have the latest version.'
    case 'error':
      return 'Could not check for updates right now.'
    default:
      return ''
  }
}

export function About({ update }: { update: UpdateState }): ReactNode {
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [tuned, setTuned] = useState(false)
  useEffect(() => {
    void call('app:info').then(setInfo)
    void call('taste:status').then((s) => setTuned(s.tuned))
  }, [])
  if (!info) return null

  return (
    <div className="page">
      <h1>CrapCut</h1>
      <p className="muted">Version {info.version} · free and open source (MIT)</p>

      <div className="row" style={{ marginTop: 16 }}>
        {update.kind === 'ready' ? (
          <button type="button" className="btn primary" onClick={() => void call('app:installUpdate')}>
            <Download size={14} /> Restart to update
          </button>
        ) : (
          <button type="button" className="btn" onClick={() => void call('app:checkUpdates')} disabled={update.kind === 'checking' || update.kind === 'downloading'}>
            {update.kind === 'checking' ? <Spinner /> : <RefreshCw size={14} />} Check for updates
          </button>
        )}
        <span className="small muted">{updateLine(update)}</span>
      </div>

      <div className="row" style={{ marginTop: 22 }}>
        <button type="button" className="btn" onClick={() => void call('app:openOutputFolder')}>
          <FolderOpen size={14} /> Open clips folder
        </button>
        <button type="button" className="btn" onClick={() => void call('app:openLogFolder')}>
          <FileText size={14} /> Open log folder
        </button>
      </div>
      <p className="small faint">If something goes wrong, send the file crapcut.log from the log folder. It has no personal information.</p>

      {tuned && (
        <div className="row" style={{ marginTop: 22 }}>
          <button type="button" className="btn sm ghost" onClick={() => void call('taste:reset').then(() => setTuned(false))}>
            <RotateCcw size={13} /> Reset what CrapCut has learned from your picks
          </button>
        </div>
      )}

      <h2 style={{ marginTop: 34 }}>Privacy</h2>
      <p className="muted small">
        CrapCut has no account, no servers and no tracking. It only connects to the internet to download the VOD you paste, to download its tools and models from their official sources, and to check GitHub for app updates.
      </p>

      <h2 style={{ marginTop: 28 }}>Licences</h2>
      <p className="muted small">CrapCut uses these free tools and models. Each keeps its own licence.</p>
      <div className="card licences">
        {info.licences.map((l) => (
          <div key={`${l.name}-${l.version}`} className="licence small">
            <div className="grow">
              <div>{l.name}</div>
              {l.note && <div className="faint">{l.note}</div>}
            </div>
            <span className="faint ellipsis">{l.version}</span>
            <button type="button" className="link" onClick={() => void call('app:openLicence', l.url)}>
              {l.licence}
            </button>
          </div>
        ))}
      </div>
    </div>
  )
}
