import { describe, expect, it } from 'vitest'
import { STEP_IDS, type BestOfItem, type ExportItem, type JobSummary, type StepId, type StepState } from '@shared/types'
import { taskbarState } from './taskbar'

const step = (status: StepState['status'], progress = status === 'done' ? 1 : 0): StepState => ({ status, progress, etaSec: null, detail: null })
const job = (status: JobSummary['status'], steps: Partial<Record<StepId, StepState>> = {}): Pick<JobSummary, 'status' | 'steps'> => ({
  status,
  steps: Object.fromEntries(STEP_IDS.map((s) => [s, steps[s] ?? step('pending')])) as Record<StepId, StepState>
})
const exp = (status: ExportItem['status'], progress: number): ExportItem => ({ id: 'e', jobId: 'j', clipId: 'c', format: 'vertical', platform: null, status, progress, etaSec: null, file: null, error: null, note: null, createdAt: 1000 })
const build = (status: BestOfItem['status'], progress: number): BestOfItem => ({ id: 'b', jobId: 'j', status, progress, etaSec: null, file: null, error: null, createdAt: 1000 })

describe('taskbarState', () => {
  it('shows nothing when nothing runs', () => {
    expect(taskbarState({ jobs: [job('review'), job('paused'), job('failed')], exports: [exp('done', 1)], bestOf: [] })).toEqual({ mode: 'none' })
  })

  it('follows a running job across its steps', () => {
    const s = taskbarState({ jobs: [job('running', { metadata: step('done'), chat: step('done'), audio: step('done'), transcribe: step('running', 0.5) })], exports: [], bestOf: [] })
    expect(s.mode).toBe('normal')
    if (s.mode === 'normal') expect(s.value).toBeGreaterThan(0.2)
  })

  it('spins while a job has not really started', () => {
    expect(taskbarState({ jobs: [job('running', { metadata: step('running', 0) })], exports: [], bestOf: [] })).toEqual({ mode: 'indeterminate' })
  })

  it('follows a running export, and a waiting one counts as not started', () => {
    expect(taskbarState({ jobs: [], exports: [exp('running', 0.5), exp('queued', 0)], bestOf: [] })).toEqual({ mode: 'normal', value: 0.25 })
    expect(taskbarState({ jobs: [], exports: [exp('queued', 0)], bestOf: [] })).toEqual({ mode: 'indeterminate' })
  })

  it('averages what is known when a job and a best-of build run together', () => {
    const s = taskbarState({ jobs: [job('running', { metadata: step('running', 0) })], exports: [], bestOf: [build('running', 0.6)] })
    expect(s).toEqual({ mode: 'normal', value: 0.6 })
  })
})
