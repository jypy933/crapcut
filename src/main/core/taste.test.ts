import { describe, expect, it } from 'vitest'
import type { MomentSignals, MomentSource } from '@shared/types'
import { DEFAULT_TASTE_ADJUSTMENTS, deriveTasteAdjustments, hasEnoughHistory, TUNED_AT_DECISIONS, type TasteDecision } from './taste'

function signals(source: MomentSource): MomentSignals {
  return { chatZ: source === 'chat' ? 3 : 0, audioZ: source === 'audio' ? 3 : 0, score: 0.5, rating: null, source }
}

function decision(status: 'accepted' | 'rejected', source: MomentSource, editStart = 0, editEnd = 0): TasteDecision {
  return {
    status,
    signals: signals(source),
    suggested: { start: 100, end: 130 },
    final: { start: 100 + editStart, end: 130 + editEnd }
  }
}

describe('deriveTasteAdjustments', () => {
  it('returns exactly the defaults with no history', () => {
    expect(deriveTasteAdjustments([])).toEqual(DEFAULT_TASTE_ADJUSTMENTS)
  })

  it('ignores pending decisions entirely', () => {
    const decisions: TasteDecision[] = [{ ...decision('accepted', 'chat'), status: 'accepted' }]
    const withPending = [...decisions, { ...decision('accepted', 'chat'), status: 'pending' as never }]
    expect(deriveTasteAdjustments(withPending)).toEqual(deriveTasteAdjustments(decisions))
  })

  it('barely moves weights with only a couple of decisions', () => {
    const decisions = [decision('accepted', 'chat'), decision('rejected', 'audio')]
    const adj = deriveTasteAdjustments(decisions)
    expect(adj.chatWeight).toBeGreaterThan(1)
    expect(adj.chatWeight).toBeLessThan(1.1)
    expect(adj.audioWeight).toBeLessThan(1)
    expect(adj.audioWeight).toBeGreaterThan(0.9)
  })

  it('raises the weight of a consistently kept signal and lowers a consistently skipped one, once there is history', () => {
    const decisions: TasteDecision[] = []
    for (let i = 0; i < 40; i++) decisions.push(decision('accepted', 'chat'))
    for (let i = 0; i < 40; i++) decisions.push(decision('rejected', 'audio'))
    const adj = deriveTasteAdjustments(decisions)
    expect(adj.chatWeight).toBeGreaterThan(1.2)
    expect(adj.audioWeight).toBeLessThan(0.8)
  })

  it('never lets a weight leave a safe range, however lopsided the history', () => {
    const decisions: TasteDecision[] = []
    for (let i = 0; i < 500; i++) decisions.push(decision('accepted', 'chat'))
    for (let i = 0; i < 500; i++) decisions.push(decision('rejected', 'transcript'))
    const adj = deriveTasteAdjustments(decisions)
    expect(adj.chatWeight).toBeLessThanOrEqual(1.5)
    expect(adj.transcriptWeight).toBeGreaterThanOrEqual(0.6)
  })

  it('learns lead-in and lead-out padding from how kept clips were trimmed', () => {
    const decisions: TasteDecision[] = []
    // He always pushes the start later (wants less lead-in) and the end later (wants more lead-out).
    for (let i = 0; i < 40; i++) decisions.push(decision('accepted', 'chat', 5, 8))
    const adj = deriveTasteAdjustments(decisions)
    expect(adj.leadInSec).toBeLessThan(DEFAULT_TASTE_ADJUSTMENTS.leadInSec)
    expect(adj.leadOutSec).toBeGreaterThan(DEFAULT_TASTE_ADJUSTMENTS.leadOutSec)
  })

  it('keeps lead-in and lead-out within their bounds however extreme the trims', () => {
    const decisions: TasteDecision[] = []
    for (let i = 0; i < 500; i++) decisions.push(decision('accepted', 'chat', 1000, 1000))
    const adj = deriveTasteAdjustments(decisions)
    expect(adj.leadInSec).toBeGreaterThanOrEqual(8)
    expect(adj.leadOutSec).toBeLessThanOrEqual(20)
  })

  it('ignores rejected clips when learning padding (nothing was trimmed on purpose)', () => {
    const decisions: TasteDecision[] = []
    for (let i = 0; i < 40; i++) decisions.push(decision('rejected', 'chat', 20, 20))
    const adj = deriveTasteAdjustments(decisions)
    expect(adj.leadInSec).toBe(DEFAULT_TASTE_ADJUSTMENTS.leadInSec)
    expect(adj.leadOutSec).toBe(DEFAULT_TASTE_ADJUSTMENTS.leadOutSec)
  })

  it('is deterministic', () => {
    const decisions = [decision('accepted', 'chat', 3, -2), decision('rejected', 'audio'), decision('accepted', 'transcript', -1, 1)]
    expect(deriveTasteAdjustments(decisions)).toEqual(deriveTasteAdjustments(decisions))
  })
})

describe('hasEnoughHistory', () => {
  it('is false with little history and true once enough decisions pile up', () => {
    const few = Array.from({ length: TUNED_AT_DECISIONS - 1 }, () => decision('accepted', 'chat'))
    const enough = Array.from({ length: TUNED_AT_DECISIONS }, () => decision('accepted', 'chat'))
    expect(hasEnoughHistory(few)).toBe(false)
    expect(hasEnoughHistory(enough)).toBe(true)
  })
})
