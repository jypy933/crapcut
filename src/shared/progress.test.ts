import { describe, expect, it } from 'vitest'
import { freshEta, jobFraction, jobStepLine, STALE_ETA_MS, summarizeWork, workLabel, workPillText } from './progress'
import { STEP_IDS, type JobSummary, type StepId, type StepState } from './types'

const step = (status: StepState['status'], progress = status === 'done' ? 1 : 0, etaSec: number | null = null, detail: string | null = null): StepState => ({ status, progress, etaSec, detail })

function job(steps: Partial<Record<StepId, StepState>>, over: Partial<JobSummary> = {}): JobSummary {
  return {
    id: 'job-1',
    url: 'https://www.twitch.tv/videos/1',
    vodId: '1',
    vod: null,
    status: 'running',
    currentStep: null,
    steps: Object.fromEntries(STEP_IDS.map((s) => [s, steps[s] ?? step('pending')])) as Record<StepId, StepState>,
    error: null,
    createdAt: 0,
    updatedAt: 1000,
    clipCount: 0,
    ...over
  }
}

describe('freshEta', () => {
  it('drops an estimate nobody has refreshed lately', () => {
    expect(freshEta(90, 1000, 1000 + STALE_ETA_MS)).toBe(90)
    expect(freshEta(90, 1000, 1001 + STALE_ETA_MS)).toBeNull()
    expect(freshEta(null, 1000, 1000)).toBeNull()
  })
})

describe('jobFraction', () => {
  it('is 0 for a new job and 1 for a finished one', () => {
    expect(jobFraction(job({}))).toBe(0)
    expect(jobFraction(job(Object.fromEntries(STEP_IDS.map((s) => [s, step('done')]))))).toBe(1)
  })
  it('counts skipped steps as done and weighs the long steps more', () => {
    const early = jobFraction(job({ metadata: step('done'), chat: step('done'), audio: step('skipped') }))
    const halfTranscribe = jobFraction(job({ metadata: step('done'), chat: step('done'), audio: step('done'), transcribe: step('running', 0.5) }))
    expect(early).toBeGreaterThan(0)
    expect(halfTranscribe).toBeGreaterThan(early)
    expect(halfTranscribe).toBeLessThan(0.6)
  })
})

describe('jobStepLine', () => {
  it('describes the running step with percent, time left and detail', () => {
    const j = job({ clipCaptions: step('running', 0.25, 120, ' Clip 3 of 12 ') }, { currentStep: 'clipCaptions' })
    expect(jobStepLine(j, 2000)).toEqual({ step: 'Sharpening captions', percent: 25, etaSec: 120, detail: 'Clip 3 of 12' })
  })
  it('leaves out what it does not know yet', () => {
    const j = job({ transcribe: step('running', 0.001, 300) }, { currentStep: 'transcribe' })
    expect(jobStepLine(j, 2000)).toEqual({ step: 'Transcribing', percent: null, etaSec: 300, detail: null })
  })
  it('hides a time left that has gone stale', () => {
    const j = job({ transcribe: step('running', 0.4, 300) }, { currentStep: 'transcribe', updatedAt: 1000 })
    expect(jobStepLine(j, 1000 + STALE_ETA_MS + 1)?.etaSec).toBeNull()
  })
  it('is null unless the job is running a step', () => {
    expect(jobStepLine(job({}, { status: 'paused', currentStep: 'audio' }), 2000)).toBeNull()
    expect(jobStepLine(job({}, { status: 'running', currentStep: null }), 2000)).toBeNull()
  })
})

describe('summarizeWork', () => {
  const item = (status: 'queued' | 'running' | 'done' | 'failed' | 'cancelled', progress: number, createdAt: number, etaSec: number | null = null) => ({ status, progress, etaSec, createdAt })

  it('is null when nothing is queued or running', () => {
    expect(summarizeWork([])).toBeNull()
    expect(summarizeWork([item('done', 1, 100), item('failed', 0, 100)])).toBeNull()
  })

  it('counts one batch: finished, running and waiting', () => {
    const s = summarizeWork([item('done', 1, 1000), item('running', 0.5, 1000, 30), item('queued', 0, 1000), item('queued', 0, 1000)])!
    expect(s).toMatchObject({ total: 4, done: 1, running: 1, queued: 2, failed: 0 })
    expect(s.fraction).toBeCloseTo(1.5 / 4)
    // 30 s left of the half it has to do, so about 60 s each: 30 + 2 * 60.
    expect(s.etaSec).toBe(150)
  })

  it('hides the batch time until the running item is far enough along to judge by', () => {
    expect(summarizeWork([item('running', 0.05, 1000, 30), item('queued', 0, 1000)])!.etaSec).toBeNull()
    expect(summarizeWork([item('running', 0.05, 1000, 30)])!.etaSec).toBe(30) // nothing waiting: its own time is enough
    expect(summarizeWork([item('running', 0.5, 1000, null), item('queued', 0, 1000)])!.etaSec).toBeNull()
  })

  it('drops a time left the UI has not heard about lately', () => {
    const seen = { ...item('running', 0.5, 1000, 30), seenAt: 1000 }
    expect(summarizeWork([seen, item('queued', 0, 1000)], 1000 + STALE_ETA_MS)!.etaSec).toBe(90)
    expect(summarizeWork([seen, item('queued', 0, 1000)], 1001 + STALE_ETA_MS)!.etaSec).toBeNull()
    expect(summarizeWork([seen], 1001 + STALE_ETA_MS)!.etaSec).toBeNull()
  })

  it('gives the time left when one item is left', () => {
    const s = summarizeWork([item('done', 1, 1000), item('running', 0.8, 1000, 12)])!
    expect(s.etaSec).toBe(12)
    expect(s.fraction).toBeCloseTo(0.9)
  })

  it('leaves out older batches and cancelled items', () => {
    const day = 24 * 3600 * 1000
    const s = summarizeWork([item('done', 1, 1000), item('done', 1, 1000), item('cancelled', 0, day), item('running', 0.2, day)])!
    expect(s.total).toBe(1)
    expect(s.done).toBe(0)
  })

  it('shows failures without hiding them from the count', () => {
    const s = summarizeWork([item('failed', 0, 1000), item('running', 0, 1000)])!
    expect(s).toMatchObject({ total: 2, failed: 1, running: 1 })
    expect(s.fraction).toBeCloseTo(0.5)
  })
})

describe('workLabel', () => {
  const base = { total: 5, done: 1, running: 1, queued: 3, failed: 0, fraction: 0.3, etaSec: null }
  it('names the export in progress', () => {
    expect(workLabel('export', base)).toBe('Exporting clip 2 of 5')
    expect(workLabel('export', { ...base, total: 1, done: 0, queued: 0 })).toBe('Exporting the clip')
  })
  it('says waiting while nothing has started', () => {
    expect(workLabel('export', { ...base, running: 0 })).toBe('Waiting to export')
    expect(workLabel('bestOf', { ...base, running: 0 })).toBe('Waiting to build the best-of video')
  })
  it('names the best-of build', () => {
    expect(workLabel('bestOf', base)).toBe('Building the best-of video')
  })
})

describe('workPillText', () => {
  const base = { total: 4, done: 1, running: 1, queued: 2, failed: 0, fraction: 0.3, etaSec: 120 }
  it('keeps the pill short and the tooltip full', () => {
    expect(workPillText('export', base, 0.3)).toEqual({ short: 'Exporting 2 of 4 · 2 min', full: 'Exporting clip 2 of 4 · about 2 min left' })
  })
  it('falls back to a percentage without a time left', () => {
    expect(workPillText('export', { ...base, etaSec: null }, 0.3).short).toBe('Exporting 2 of 4 · 30%')
    expect(workPillText('export', { ...base, etaSec: null }, 0).short).toBe('Exporting 2 of 4')
  })
  it('covers a single clip, waiting and the best-of build', () => {
    expect(workPillText('export', { ...base, total: 1, etaSec: 30 }, 0.5).short).toBe('Exporting · <1 min')
    expect(workPillText('export', { ...base, running: 0, etaSec: null }, 0).short).toBe('Waiting to export')
    expect(workPillText('bestOf', { ...base, etaSec: 4000 }, 0.5)).toEqual({ short: 'Building best-of · 1 h 7 min', full: 'Building the best-of video · about 1 h 7 min left' })
  })
})
