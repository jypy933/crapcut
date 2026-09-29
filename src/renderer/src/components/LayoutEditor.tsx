import { Copy, Plus, Star, Trash2 } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { dragLayout, duplicateLayout, newLayout, normalizeLayout, roundRect, withKind, type Handle, type Size } from '@shared/layoutGeometry'
import type { Layout, LayoutKind } from '@shared/types'
import { call, errorText } from '../api'
import { drawFrame } from '../lib/compose'
import { Segmented } from './ui'

interface Props {
  src: string
  /** Seconds into the clip file to show. */
  at: number
  layouts: Layout[]
  defaultId: string | null
  /** The layout of the clip being reviewed, opened first. */
  clipLayoutId: string | null
  onClose: () => void
  /** After any change, with the full list and the default. */
  onChanged: (layouts: Layout[], defaultId: string | null) => void
  onDeleted: (id: string) => void
  onUse: (id: string, all: boolean) => void
}

const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w']
const GUESS: Size = { width: 1920, height: 1080 }

const KIND_HINT: Record<LayoutKind, string> = {
  cam_game: 'Drag the purple box over your facecam. The green box is the part of the game shown below it.',
  blur_fill: 'The whole frame, with blurred edges filling the rest of the vertical video.',
  center_crop: 'A vertical slice of the game, no facecam. Drag the green box to choose it.'
}

const roundLayout = (l: Layout): Layout => ({ ...l, cam: l.cam ? roundRect(l.cam) : null, game: roundRect(l.game) })

function Box({
  rect,
  kind,
  label,
  onStart,
  onDrag,
  onDone
}: {
  rect: Layout['game']
  kind: 'cam' | 'game'
  label: string
  onStart: () => void
  onDrag: (handle: Handle, dx: number, dy: number) => void
  onDone: () => void
}): ReactNode {
  function start(handle: Handle, e: React.PointerEvent): void {
    e.stopPropagation()
    e.preventDefault()
    const area = (e.currentTarget as HTMLElement).closest('.layout-canvas')!.getBoundingClientRect()
    onStart()
    const x0 = e.clientX
    const y0 = e.clientY
    const move = (ev: PointerEvent): void => onDrag(handle, (ev.clientX - x0) / area.width, (ev.clientY - y0) / area.height)
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      onDone()
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }
  return (
    <div
      className={`rect ${kind}`}
      style={{ left: `${rect.x * 100}%`, top: `${rect.y * 100}%`, width: `${rect.w * 100}%`, height: `${rect.h * 100}%` }}
      onPointerDown={(e) => start('move', e)}
    >
      <span className="tag">{label}</span>
      {HANDLES.map((h) => (
        <span key={h} className={`grip ${h}`} data-handle={h} onPointerDown={(e) => start(h, e)} />
      ))}
    </div>
  )
}

export function LayoutEditor({ src, at, layouts: initial, defaultId: initialDefault, clipLayoutId, onClose, onChanged, onDeleted, onUse }: Props): ReactNode {
  const video = useRef<HTMLVideoElement>(null)
  const preview = useRef<HTMLCanvasElement>(null)
  const [layouts, setLayouts] = useState(initial)
  const [defaultId, setDefaultId] = useState(initialDefault)
  const [selectedId, setSelectedId] = useState<string | null>(() => (initial.some((l) => l.id === clipLayoutId) ? clipLayoutId : (initial[0]?.id ?? null)))
  const [source, setSource] = useState<Size>(GUESS)
  const [aspect, setAspect] = useState(16 / 9)
  const [draft, setDraft] = useState<Layout | null>(null)
  const [name, setName] = useState('')
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The layout when the current drag began, and the newest result of it.
  const base = useRef<Layout | null>(null)
  const latest = useRef<Layout | null>(null)
  const [known, setKnown] = useState(false)

  const stored = layouts.find((l) => l.id === selectedId) ?? null
  // What the export will really crop: old layouts open snapped to it.
  const view = useMemo(() => draft ?? (stored ? normalizeLayout(stored, source) : null), [draft, stored, source])

  useEffect(() => setName(stored?.name ?? ''), [stored?.id, stored?.name])
  useEffect(() => setConfirmDelete(false), [selectedId])

  useEffect(() => {
    const v = video.current
    if (!v) return
    const ready = (): void => {
      if (v.videoWidth && v.videoHeight) {
        setSource({ width: v.videoWidth, height: v.videoHeight })
        setAspect(v.videoWidth / v.videoHeight)
        setKnown(true)
      }
      v.currentTime = at
    }
    if (v.readyState >= 1) ready()
    else v.addEventListener('loadedmetadata', ready, { once: true })
  }, [at])

  // The vertical preview is the review preview's own drawing code on this frame.
  const paint = useCallback((): void => {
    const v = video.current
    const ctx = preview.current?.getContext('2d')
    if (v && ctx && view) drawFrame(ctx, v, view, 'vertical')
  }, [view])
  useEffect(() => {
    paint()
    const v = video.current
    v?.addEventListener('seeked', paint)
    v?.addEventListener('loadeddata', paint)
    return () => {
      v?.removeEventListener('seeked', paint)
      v?.removeEventListener('loadeddata', paint)
    }
  }, [paint])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const commit = useCallback(
    async (next: Layout, makeDefault = false): Promise<void> => {
      const saved = roundLayout(next)
      const list = layouts.some((l) => l.id === saved.id) ? layouts.map((l) => (l.id === saved.id ? saved : l)) : [...layouts, saved]
      setLayouts(list)
      setDraft(null)
      try {
        await call('layouts:save', saved)
        if (makeDefault) await call('layouts:setDefault', saved.id)
        const nextDefault = makeDefault ? saved.id : defaultId
        if (makeDefault) setDefaultId(saved.id)
        onChanged(list, nextDefault)
      } catch (err) {
        setError(errorText(err))
      }
    },
    [layouts, defaultId, onChanged]
  )

  // A fresh layout when the editor is opened with none (the "Mark facecam" path), once.
  const seeded = useRef(initial.length > 0)
  useEffect(() => {
    if (seeded.current || layouts.length > 0 || !known) return
    seeded.current = true
    const l = newLayout(crypto.randomUUID(), 'Facecam', 'cam_game', source)
    setSelectedId(l.id)
    void commit(l, true)
  }, [layouts.length, known, source, commit])

  function create(): void {
    let n = layouts.length + 1
    while (layouts.some((l) => l.name === `Layout ${n}`)) n++
    const l = newLayout(crypto.randomUUID(), `Layout ${n}`, 'cam_game', source)
    setSelectedId(l.id)
    void commit(l, layouts.length === 0)
  }

  function duplicate(): void {
    if (!view) return
    const l = duplicateLayout(view, crypto.randomUUID(), layouts.map((x) => x.name))
    setSelectedId(l.id)
    void commit(l)
  }

  async function remove(): Promise<void> {
    if (!stored) return
    const id = stored.id
    const list = layouts.filter((l) => l.id !== id)
    try {
      await call('layouts:delete', id)
    } catch (err) {
      setError(errorText(err))
      return
    }
    const nextDefault = defaultId === id ? null : defaultId
    setLayouts(list)
    setDefaultId(nextDefault)
    setSelectedId(list[0]?.id ?? null)
    onChanged(list, nextDefault)
    onDeleted(id)
  }

  async function makeDefault(): Promise<void> {
    if (!stored) return
    try {
      await call('layouts:setDefault', stored.id)
      setDefaultId(stored.id)
      onChanged(layouts, stored.id)
    } catch (err) {
      setError(errorText(err))
    }
  }

  function rename(): void {
    const next = name.trim().slice(0, 40)
    if (!stored || !next) return setName(stored?.name ?? '')
    if (next !== stored.name) void commit({ ...(view ?? stored), name: next })
  }

  const dragProps = (target: 'cam' | 'game', current: Layout): { onStart: () => void; onDrag: (h: Handle, dx: number, dy: number) => void; onDone: () => void } => ({
    onStart: () => {
      base.current = current
      latest.current = null
    },
    onDrag: (h, dx, dy) => {
      const next = dragLayout(base.current ?? current, target, h, dx, dy, source)
      latest.current = next
      setDraft(next)
    },
    onDone: () => {
      const done = latest.current
      latest.current = null
      if (done) void commit(done)
    }
  })

  const isDefault = !!stored && stored.id === defaultId
  const inUse = !!stored && stored.id === clipLayoutId

  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal layout-editor" role="dialog" aria-label="Layouts">
        <aside className="layout-list">
          <h2>Layouts</h2>
          <div className="layout-items">
            {layouts.map((l) => (
              <button key={l.id} type="button" className={`layout-item${l.id === selectedId ? ' on' : ''}`} onClick={() => setSelectedId(l.id)}>
                <span className="grow">{l.name}</span>
                {l.id === defaultId && <Star size={12} aria-label="Default" />}
              </button>
            ))}
          </div>
          <button type="button" className="btn" onClick={create}>
            <Plus size={14} /> New layout
          </button>
        </aside>

        <div className="layout-main">
          {view && stored && (
            <>
              <div className="row">
                <input
                  className="input grow"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  onBlur={rename}
                  onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                  maxLength={40}
                  aria-label="Layout name"
                />
                <div style={{ width: 360, flex: "none" }}>
                  <Segmented<LayoutKind>
                    value={view.kind}
                    onChange={(kind) => void commit(withKind(view, kind, source))}
                    options={[
                      { value: 'cam_game', label: 'Facecam + game' },
                      { value: 'blur_fill', label: 'Full frame' },
                      { value: 'center_crop', label: 'Center crop' }
                    ]}
                  />
                </div>
              </div>
              <p className="muted small" style={{ margin: 0 }}>
                {KIND_HINT[view.kind]}
              </p>
            </>
          )}
          <div className="layout-stage">
            <div className="layout-canvas" style={{ aspectRatio: String(aspect) }}>
              <video ref={video} src={src} preload="auto" muted playsInline />
              {view && <Box rect={view.game} kind="game" label="Game" {...dragProps('game', view)} />}
              {view && view.kind === 'cam_game' && view.cam && <Box rect={view.cam} kind="cam" label="Facecam" {...dragProps('cam', view)} />}
            </div>
            <div className="layout-preview">
              <canvas ref={preview} width={270} height={480} aria-label="Vertical preview" />
            </div>
          </div>
          <div className="row layout-actions">
            {stored ? (
              <>
                <button type="button" className="btn ghost sm" onClick={duplicate}>
                  <Copy size={13} /> Duplicate
                </button>
                <button type="button" className="btn ghost sm" onClick={() => void makeDefault()} disabled={isDefault} title="Used for clips found in future VODs">
                  <Star size={13} /> {isDefault ? 'Default' : 'Make default'}
                </button>
                {confirmDelete ? (
                  <button type="button" className="btn ghost sm danger" onClick={() => void remove()} onBlur={() => setConfirmDelete(false)} autoFocus>
                    <Trash2 size={13} /> Really delete?
                  </button>
                ) : (
                  <button type="button" className="btn ghost sm danger" onClick={() => setConfirmDelete(true)}>
                    <Trash2 size={13} /> Delete
                  </button>
                )}
              </>
            ) : (
              <span className="muted small">No layouts yet.</span>
            )}
            <div className="grow" />
            {error && (
              <span className="error small" onClick={() => setError(null)}>
                {error}
              </span>
            )}
            {stored && (
              <>
                <button type="button" className="btn" onClick={() => onUse(stored.id, true)}>
                  Use for every clip
                </button>
                <button type="button" className="btn primary" onClick={() => onUse(stored.id, false)} disabled={inUse}>
                  {inUse ? 'In use' : 'Use for this clip'}
                </button>
              </>
            )}
            <button type="button" className="btn ghost" onClick={onClose}>
              Done
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
