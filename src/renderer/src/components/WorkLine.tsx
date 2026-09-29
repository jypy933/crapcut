import type { ReactNode } from 'react'
import { formatEta } from '@shared/format'
import { ProgressBar } from './ui'

/** One quiet line ("Exporting clip 2 of 5 · 40% · about 1 min left") over a thin bar. */
export function WorkLine({ label, fraction, etaSec, note, started = true }: { label: string; fraction: number; etaSec: number | null; note?: string | null; started?: boolean }): ReactNode {
  const eta = formatEta(etaSec)
  return (
    <div className="work-line">
      <div className="small muted">
        {label}
        {started && fraction > 0.005 ? ` · ${Math.round(fraction * 100)}%` : ''}
        {eta ? ` · ${eta} left` : ''}
        {note ? <span className="faint"> · {note}</span> : null}
      </div>
      <ProgressBar value={started ? fraction : 0} />
    </div>
  )
}
