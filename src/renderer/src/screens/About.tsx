import { AlertCircle, Check, Circle, Download, FileText, FolderOpen, RefreshCw, RotateCcw, Trash2 } from 'lucide-react'
import { useEffect, useState, type ReactNode } from 'react'
import { formatBytes } from '@shared/format'
import { buildOptionalModels, type OptionalModel } from '@shared/optionalModels'
import type { AppInfo, AutostartStatus, SetupStatus, UpdateState } from '@shared/types'
import { call, errorText, useEvent } from '../api'
import { ProgressBar, Spinner, Toggle } from '../components/ui'

const ACTIVE_STATES = new Set(['downloading', 'verifying', 'installing'])

function ModelPartRow({ model, onDownload, onCancel, onRemove }: { model: OptionalModel; onDownload: () => void; onCancel: () => void; onRemove: () => void }): ReactNode {
  const busy = ACTIVE_STATES.has(model.state)
  return (
    <div className="model-part">
      <span>
        {model.state === 'ready' ? (
          <Check size={16} color="var(--good)" />
        ) : model.state === 'failed' ? (
          <AlertCircle size={16} color="var(--warn)" />
        ) : busy ? (
          <Spinner />
        ) : (
          <Circle size={14} color="var(--text-3)" />
        )}
      </span>
      <div className="grow">
        <div className="ellipsis">
          {model.label}
          {model.variant && <span className="faint"> · {model.variant}</span>}
        </div>
        <div className="small faint">{model.description}</div>
        {busy && <ProgressBar value={model.state === 'downloading' ? model.progress : 1} good={model.state !== 'downloading'} />}
        {model.state === 'failed' && <div className="small faint">Could not download. Check your internet connection and try again.</div>}
      </div>
      <span className="small faint" style={{ textAlign: 'right' }}>
        {model.state === 'verifying' ? 'Checking...' : model.state === 'installing' ? 'Installing...' : formatBytes(model.sizeBytes)}
      </span>
      {model.state === 'ready' ? (
        <button type="button" className="btn sm ghost" onClick={onRemove}>
          <Trash2 size={13} /> Remove
        </button>
      ) : busy ? (
        <button type="button" className="btn sm ghost" onClick={onCancel}>
          Cancel
        </button>
      ) : (
        <button type="button" className="btn sm" onClick={onDownload}>
          <Download size={13} /> {model.state === 'failed' ? 'Retry' : 'Download'}
        </button>
      )}
    </div>
  )
}

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
  const [autostart, setAutostart] = useState<AutostartStatus | null>(null)
  const [setup, setSetup] = useState<SetupStatus | null>(null)
  const [modelsError, setModelsError] = useState<string | null>(null)
  useEffect(() => {
    void call('app:info').then(setInfo)
    void call('taste:status').then((s) => setTuned(s.tuned))
    void call('settings:getAutostart').then(setAutostart)
    void call('setup:status').then(setSetup)
  }, [])
  useEvent('setup:status', setSetup)
  if (!info) return null

  const models = setup?.hardware ? buildOptionalModels(setup.hardware, setup.components) : []

  function downloadModel(id: OptionalModel['id']): void {
    setModelsError(null)
    void call('models:download', id).catch((err) => setModelsError(errorText(err)))
  }
  function removeModel(id: OptionalModel['id']): void {
    setModelsError(null)
    void call('models:remove', id).catch((err) => setModelsError(errorText(err)))
  }

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

      {autostart && (
        <label className="row small" style={{ marginTop: 18 }}>
          <Toggle
            on={autostart.enabled}
            label="Start with Windows"
            onChange={(enabled) => {
              setAutostart(autostart && { ...autostart, enabled })
              void call('settings:setAutostart', enabled).then(setAutostart)
            }}
          />
          Start with Windows
        </label>
      )}

      {models.length > 0 && (
        <>
          <h2 style={{ marginTop: 34 }}>Optional AI parts</h2>
          <p className="muted small">Not required. Each downloads once from its official source and is checked before use.</p>
          <div className="card model-parts">
            {models.map((m) => (
              <ModelPartRow key={m.id} model={m} onDownload={() => downloadModel(m.id)} onCancel={() => void call('setup:cancel')} onRemove={() => removeModel(m.id)} />
            ))}
          </div>
          {modelsError && (
            <div className="error">
              <AlertCircle size={15} style={{ flex: 'none', marginTop: 2 }} />
              {modelsError}
            </div>
          )}
        </>
      )}

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
