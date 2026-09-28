import { useRef, useState, type ReactNode } from 'react'
import type { Range, Word } from '@shared/types'

interface Props {
  bounds: Range
  value: Range
  time: number
  words: Word[]
  onSeek: (t: number) => void
  onChange: (r: Range) => void
}

const MIN_LEN = 3

/** Trim bar: the downloaded range, the cut (drag the handles) and the playhead. */
export function Timeline({ bounds, value, time, words, onSeek, onChange }: Props): ReactNode {
  const el = useRef<HTMLDivElement>(null)
  const [draft, setDraft] = useState<Range | null>(null)
  const span = Math.max(0.001, bounds.end - bounds.start)
  const cur = draft ?? value
  const pct = (t: number): string => `${((Math.max(bounds.start, Math.min(bounds.end, t)) - bounds.start) / span) * 100}%`

  function timeAt(clientX: number): number {
    const r = el.current!.getBoundingClientRect()
    return bounds.start + (Math.max(0, Math.min(r.width, clientX - r.left)) / r.width) * span
  }

  function drag(which: 'start' | 'end', e: React.PointerEvent): void {
    e.stopPropagation()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    let latest = cur
    const move = (ev: PointerEvent): void => {
      const t = timeAt(ev.clientX)
      latest = which === 'start' ? { start: Math.min(t, cur.end - MIN_LEN), end: cur.end } : { start: cur.start, end: Math.max(t, cur.start + MIN_LEN) }
      setDraft(latest)
      onSeek(which === 'start' ? latest.start : Math.max(latest.start, latest.end - 2))
    }
    const up = (): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      setDraft(null)
      if (latest.start !== value.start || latest.end !== value.end) onChange(latest)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

  return (
    <div className="timeline" ref={el} onPointerDown={(e) => onSeek(timeAt(e.clientX))} role="slider" aria-label="Clip cut" aria-valuemin={bounds.start} aria-valuemax={bounds.end} aria-valuenow={time}>
      {words.map((w, i) => (
        <div key={i} className="words" style={{ left: pct(w.t0), width: `${(Math.max(0.05, w.t1 - w.t0) / span) * 100}%` }} />
      ))}
      <div className="sel" style={{ left: pct(cur.start), width: `calc(${pct(cur.end)} - ${pct(cur.start)})` }} />
      <div className="handle" style={{ left: pct(cur.start) }} onPointerDown={(e) => drag('start', e)} title="Drag to change the start" />
      <div className="handle" style={{ left: pct(cur.end) }} onPointerDown={(e) => drag('end', e)} title="Drag to change the end" />
      <div className="head" style={{ left: pct(time) }} />
    </div>
  )
}
