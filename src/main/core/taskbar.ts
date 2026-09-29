// What the Windows taskbar button shows while CrapCut works: one bar that
// follows the running jobs and the exports / best-of builds under way.

import { jobFraction, summarizeWork } from '@shared/progress'
import type { BestOfItem, ExportItem, JobSummary } from '@shared/types'

export type TaskbarState = { mode: 'none' } | { mode: 'indeterminate' } | { mode: 'normal'; value: number }

/** Below this a job has not really started, so its bar would just sit empty. */
const STARTED = 0.005

export function taskbarState(input: {
  jobs: readonly Pick<JobSummary, 'status' | 'steps'>[]
  exports: readonly ExportItem[]
  bestOf: readonly BestOfItem[]
}): TaskbarState {
  const tracks: (number | null)[] = []
  for (const j of input.jobs) {
    if (j.status !== 'running') continue
    const f = jobFraction(j)
    tracks.push(f > STARTED ? f : null)
  }
  for (const items of [input.exports, input.bestOf]) {
    const s = summarizeWork(items)
    if (s) tracks.push(s.fraction > STARTED ? s.fraction : null)
  }
  if (tracks.length === 0) return { mode: 'none' }
  const known = tracks.filter((f): f is number => f !== null)
  if (known.length === 0) return { mode: 'indeterminate' }
  const value = known.reduce((a, b) => a + b, 0) / known.length
  return { mode: 'normal', value: Math.max(0, Math.min(1, value)) }
}
