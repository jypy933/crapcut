import type { ReactNode } from 'react'
import { summarizeWork, workPillText } from '@shared/progress'
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
  // Everything under way, exports and best-of together, as one bar.
  const all = [exporting, building].filter((s) => s !== null)
  const fraction = all.reduce((sum, s) => sum + s.fraction, 0) / all.length
  const text = workPillText(kind, main, fraction)
  return (
    <button type="button" className="work-pill no-drag" title={text.full} onClick={() => jobId && go({ name: 'review', jobId })}>
      <span className="small work-pill-text">{text.short}</span>
      <ProgressBar value={fraction} />
    </button>
  )
}
