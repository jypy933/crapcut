import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Layout, LayoutKind, Rect } from '@shared/types'
import { Segmented } from './ui'

interface Props {
  src: string
  /** Seconds into the clip file to show. */
  at: number
  initial: Layout | null
  onCancel: () => void
  onSave: (layout: Layout, applyToAll: boolean) => void
}

const DEFAULT_CAM: Rect = { x: 0.72, y: 0.62, w: 0.26, h: 0.34 }
const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 }
const MIN = 0.04

type Handle = 'move' | 'nw' | 'ne' | 'sw' | 'se'

function clampRect(r: Rect): Rect {
  const w = Math.max(MIN, Math.min(1, r.w))
  const h = Math.max(MIN, Math.min(1, r.h))
  return { x: Math.max(0, Math.min(1 - w, r.x)), y: Math.max(0, Math.min(1 - h, r.y)), w, h }
}

function round(r: Rect): Rect {
  const f = (n: number): number => Math.round(n * 10000) / 10000
  return { x: f(r.x), y: f(r.y), w: f(r.w), h: f(r.h) }
}

function Box({ rect, kind, label, onChange }: { rect: Rect; kind: 'cam' | 'game'; label: string; onChange: (r: Rect) => void }): ReactNode {
  function start(handle: Handle, e: React.PointerEvent): void {
    e.stopPropagation()
    e.preventDefault()
    const area = (e.currentTarget as HTMLElement).closest('.layout-canvas')!.getBoundingClientRect()
    const x0 = e.clientX
    const y0 = e.clientY
    const r0 = rect
    const move = (ev: PointerEvent): void => {
      const dx = (ev.clientX - x0) / area.width
      const dy = (ev.clientY - y0) / area.height
      let r: Rect
      switch (handle) {
        case 'move':
          r = { ...r0, x: r0.x + dx, y: r0.y + dy }
          break
        case 'nw':
          r = { x: Math.min(r0.x + dx, r0.x + r0.w - MIN), y: Math.min(r0.y + dy, r0.y + r0.h - MIN), w: r0.w - dx, h: r0.h - dy }
          break
        case 'ne':
          r = { x: r0.x, y: Math.min(r0.y + dy, r0.y + r0.h - MIN), w: r0.w + dx, h: r0.h - dy }
          break
        case 'sw':
          r = { x: Math.min(r0.x + dx, r0.x + r0.w - MIN), y: r0.y, w: r0.w - dx, h: r0.h + dy }
          break
        case 'se':
          r = { x: r0.x, y: r0.y, w: r0.w + dx, h: r0.h + dy }
          break
      }
      onChange(clampRect(r))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
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
      {(['nw', 'ne', 'sw', 'se'] as const).map((h) => (
        <span key={h} className={`grip ${h}`} onPointerDown={(e) => start(h, e)} />
      ))}
    </div>
  )
}

export function LayoutEditor({ src, at, initial, onCancel, onSave }: Props): ReactNode {
  const video = useRef<HTMLVideoElement>(null)
  const [kind, setKind] = useState<LayoutKind>(initial?.kind ?? 'cam_game')
  const [cam, setCam] = useState<Rect>(initial?.cam ?? DEFAULT_CAM)
  const [game, setGame] = useState<Rect>(initial?.game ?? FULL)
  const [name, setName] = useState(initial?.name ?? 'My layout')
  const [applyAll, setApplyAll] = useState(true)
  const [aspect, setAspect] = useState(16 / 9)

  useEffect(() => {
    const v = video.current
    if (!v) return
    const ready = (): void => {
      if (v.videoWidth && v.videoHeight) setAspect(v.videoWidth / v.videoHeight)
      v.currentTime = at
    }
    if (v.readyState >= 1) ready()
    else v.addEventListener('loadedmetadata', ready, { once: true })
  }, [at])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCancel()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onCancel])

  function save(): void {
    onSave(
      {
        id: initial?.id ?? crypto.randomUUID(),
        name: name.trim().slice(0, 40) || 'My layout',
        kind,
        cam: kind === 'cam_game' ? round(cam) : null,
        game: round(game)
      },
      applyAll
    )
  }

  return (
    <div className="overlay" onPointerDown={(e) => e.target === e.currentTarget && onCancel()}>
      <div className="modal layout-editor" role="dialog" aria-label="Layout">
        <div className="row">
          <h2 className="grow" style={{ margin: 0 }}>
            Vertical layout
          </h2>
          <div style={{ width: 420 }}>
            <Segmented<LayoutKind>
              value={kind}
              onChange={setKind}
              options={[
                { value: 'cam_game', label: 'Facecam + game' },
                { value: 'blur_fill', label: 'Full frame' },
                { value: 'center_crop', label: 'Center crop' }
              ]}
            />
          </div>
        </div>
        <p className="muted small" style={{ margin: 0 }}>
          {kind === 'cam_game'
            ? 'Drag the purple box over your facecam. The green box is the part of the game to show below it.'
            : kind === 'blur_fill'
              ? 'The whole frame, with blurred edges filling the rest of the vertical video.'
              : 'A vertical slice from the middle of the green box.'}
        </p>
        <div className="layout-canvas" style={{ aspectRatio: String(aspect) }}>
          <video ref={video} src={src} preload="auto" muted playsInline />
          <Box rect={game} kind="game" label="Game" onChange={setGame} />
          {kind === 'cam_game' && <Box rect={cam} kind="cam" label="Facecam" onChange={setCam} />}
        </div>
        <div className="row">
          <input className="input" style={{ width: 220 }} value={name} onChange={(e) => setName(e.target.value)} maxLength={40} aria-label="Layout name" />
          <label className="row small muted" style={{ cursor: 'pointer' }}>
            <input type="checkbox" checked={applyAll} onChange={(e) => setApplyAll(e.target.checked)} />
            Use for every clip of this VOD
          </label>
          <div className="grow" />
          <button type="button" className="btn ghost" onClick={onCancel}>
            Cancel
          </button>
          <button type="button" className="btn primary" onClick={save}>
            Save layout
          </button>
        </div>
      </div>
    </div>
  )
}
