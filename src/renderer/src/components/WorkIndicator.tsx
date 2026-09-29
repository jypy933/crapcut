import type { ReactNode } from 'react'
import { formatEta } from '@shared/format'
import { summarizeWork, workLabel } from '@shared/progress'
import type { Route } from '../App'
import { hasActiveWork, seen, useNow, type Work } from '../lib/work'
import { ProgressBar } from './ui'

/**
 * A small pill in the title bar while exports or a best-of build run, on
 * every screen. Click to jump to the job it belongs to.
 */
export function WorkIndicator({ work, go }: { work: Work; go: (r: Route) => void }): ReactNode {
  const now = useNow(hasActiveWork(work))
  const exporting = summarizeWork(seen(work.exports, work.seenAt), now)
  const building = summarizeWork(seen(work.bestOf, work.seenAt), now)
  const main = exporting ?? building
  if (!main) return null
  const kind = exporting ? 'export' : 'bestOf'
  // The job of whatever is running now (or next in line).
  const items = [...(exporting ? work.exports : work.bestOf)].filter((i) => i.status === 'running' || i.status === 'queued')
  const jobId = (items.find((i) => i.status === 'running') ?? items[0])?.jobId
  const eta = formatEta(main.etaSec)
  // Everything under way, exports and best-of together, as one bar.
  const all = [exporting, building].filter((s) => s !== null)
  const fraction = all.reduce((sum, s) => sum + s.fraction, 0) / all.length
  return (
    <button type="button" className="work-pill no-drag" title="Show what is being made" onClick={() => jobId && go({ name: 'review', jobId })}>
      <span className="small">
        {workLabel(kind, main)}
        {eta ? <span className="faint"> · {eta} left</span> : null}
        {!eta && main.running > 0 && fraction > 0.005 ? <span className="faint"> · {Math.round(fraction * 100)}%</span> : null}
      </span>
      <ProgressBar value={fraction} />
    </button>
  )
}
