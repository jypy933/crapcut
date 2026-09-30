import { describe, expect, it } from 'vitest'
import type { ClipEditPlan } from './editPlan'
import { chosenVersion, DEFAULT_EXPORT_PLATFORMS, hasColdOpen, normalizePlatforms, platformsOverCap } from './platformExport'

const fit = (sec: number) => ({
  tiktok: { capSec: 60, fits: sec <= 60 },
  shorts: { capSec: 60, fits: sec <= 60 },
  reels: { capSec: 90, fits: sec <= 90 }
})
const plan = (finalSec: number, coldSec: number | null): ClipEditPlan => ({
  finalSec,
  editSkipped: false,
  extendedSec: 0,
  belowFloor: false,
  capFit: fit(finalSec),
  coldOpen: { qualifies: coldSec !== null, confidence: 0.8, llm: 'unavailable', payoffVodSec: null, previewSec: 2, finalSec: coldSec ?? 0, segments: [], capFit: fit(coldSec ?? 0), reasons: [] },
  loop: { eligible: false, endSec: null, seamScore: null, loudnessDiffLu: null, quietSec: null, calibrated: false }
})

describe('platform choice', () => {
  it('defaults to all three, and keeps only known platforms once each in a fixed order', () => {
    expect(normalizePlatforms(undefined)).toEqual([...DEFAULT_EXPORT_PLATFORMS])
    expect(normalizePlatforms([])).toEqual(['tiktok', 'shorts', 'reels'])
    expect(normalizePlatforms(['nope'])).toEqual(['tiktok', 'shorts', 'reels'])
    expect(normalizePlatforms(['reels', 'tiktok', 'reels', 'x'])).toEqual(['tiktok', 'reels'])
  })
})

describe('versions', () => {
  it('has a cold open to choose only with the auto edit on and a qualifying plan', () => {
    expect(hasColdOpen({ autoEdit: true, editPlan: plan(30, 33) })).toBe(true)
    expect(hasColdOpen({ autoEdit: false, editPlan: plan(30, 33) })).toBe(false)
    expect(hasColdOpen({ autoEdit: true, editPlan: plan(30, null) })).toBe(false)
    // A clip saved before plans existed has none.
    expect(hasColdOpen({ autoEdit: true })).toBe(false)
  })

  it('falls back to the straight edit when the chosen cold open is not there', () => {
    expect(chosenVersion({ autoEdit: true, version: 'coldOpen', editPlan: plan(30, 33) })).toBe('coldOpen')
    expect(chosenVersion({ autoEdit: true, version: 'coldOpen', editPlan: plan(30, null) })).toBe('straight')
    expect(chosenVersion({ autoEdit: true, editPlan: plan(30, 33) })).toBe('straight')
    expect(chosenVersion({ autoEdit: true, version: 'coldOpen' })).toBe('straight')
  })

  it('reads which platform caps the chosen version is over', () => {
    const all = ['tiktok', 'shorts', 'reels'] as const
    expect(platformsOverCap({ autoEdit: true, editPlan: plan(70, null) }, all)).toEqual(['tiktok', 'shorts'])
    expect(platformsOverCap({ autoEdit: true, editPlan: plan(70, null) }, ['reels'])).toEqual([])
    // The cold open's length counts when that version is chosen.
    expect(platformsOverCap({ autoEdit: true, version: 'coldOpen', editPlan: plan(58, 62) }, all)).toEqual(['tiktok', 'shorts'])
    expect(platformsOverCap({ autoEdit: true, editPlan: plan(58, 62) }, all)).toEqual([])
    expect(platformsOverCap({ autoEdit: true }, all)).toEqual([])
  })
})
