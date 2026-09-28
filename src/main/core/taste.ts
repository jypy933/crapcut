// Turns his past accept/reject decisions and trims into small adjustments to
// how the next VOD's moments are scored and padded. No ML: plain statistics,
// shrunk toward today's defaults while there is little history, and clamped
// so it can never make the finder pick nothing or everything -- the counts
// and thresholds that decide how many candidates exist are never touched
// here, only how the ones already found are ranked and windowed. Pure and
// deterministic.

import type { MomentSignals, MomentSource, Range } from '@shared/types'

export interface TasteDecision {
  status: 'accepted' | 'rejected'
  signals: MomentSignals
  /** The window the finder originally proposed. */
  suggested: Range
  /** The window he ended up with. */
  final: Range
}

export interface TasteAdjustments {
  /** Multiplies a candidate's chat-spike contribution. */
  chatWeight: number
  /** Multiplies a candidate's audio-loudness contribution. */
  audioWeight: number
  /** Multiplies a transcript-only candidate's signal strength. */
  transcriptWeight: number
  /** Seconds of context kept before the moment. */
  leadInSec: number
  /** Seconds of reaction kept after the moment. */
  leadOutSec: number
}

export const DEFAULT_TASTE_ADJUSTMENTS: TasteAdjustments = {
  chatWeight: 1,
  audioWeight: 1,
  transcriptWeight: 1,
  leadInSec: 18,
  leadOutSec: 10
}

const WEIGHT_MIN = 0.6
const WEIGHT_MAX = 1.5
const LEAD_IN_MIN = 8
const LEAD_IN_MAX = 30
const LEAD_OUT_MIN = 4
const LEAD_OUT_MAX = 20

/** Decisions for one signal before its weight is trusted at full strength. */
const CONFIDENCE_DECISIONS = 25
/** How strongly a source's acceptance rate can move its weight, before clamping. */
const WEIGHT_SENSITIVITY = 1.2

/** How many decisions have gone into learning so far, for the "Tuned to your picks" line. */
export const TUNED_AT_DECISIONS = CONFIDENCE_DECISIONS

function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n))
}

/** 0..1, how much a value should move away from its default given `n` decisions. */
function confidence(n: number, full = CONFIDENCE_DECISIONS): number {
  return clamp(n / full, 0, 1)
}

function mean(values: number[]): number {
  if (values.length === 0) return 0
  return values.reduce((s, v) => s + v, 0) / values.length
}

/**
 * A source's weight: how much more (or less) often clips from it get kept
 * than clips overall, shrunk toward 1 while there are few decisions for it,
 * and clamped so no source can ever dominate or drop out entirely.
 */
function weightFor(decided: TasteDecision[], source: MomentSource, baselineAcceptRate: number): number {
  const fromSource = decided.filter((d) => d.signals.source === source)
  if (fromSource.length === 0) return 1
  const acceptRate = fromSource.filter((d) => d.status === 'accepted').length / fromSource.length
  const target = clamp(1 + (acceptRate - baselineAcceptRate) * WEIGHT_SENSITIVITY, WEIGHT_MIN, WEIGHT_MAX)
  const c = confidence(fromSource.length)
  return 1 + c * (target - 1)
}

/**
 * Reads what to adjust from a history of past decisions. With no decisions
 * yet this returns exactly `DEFAULT_TASTE_ADJUSTMENTS`, so a fresh install
 * finds moments the same way it always has.
 */
export function deriveTasteAdjustments(history: TasteDecision[]): TasteAdjustments {
  const decided = history.filter((d) => d.status === 'accepted' || d.status === 'rejected')
  if (decided.length === 0) return DEFAULT_TASTE_ADJUSTMENTS

  const baselineAcceptRate = decided.filter((d) => d.status === 'accepted').length / decided.length

  const accepted = decided.filter((d) => d.status === 'accepted')
  // Only kept clips carry a real editing signal: he chose to spend time on
  // them, and any trim shows the start/end he actually wanted.
  const startDelta = mean(accepted.map((d) => d.final.start - d.suggested.start))
  const endDelta = mean(accepted.map((d) => d.final.end - d.suggested.end))
  const editConfidence = confidence(accepted.length)

  return {
    chatWeight: weightFor(decided, 'chat', baselineAcceptRate),
    audioWeight: weightFor(decided, 'audio', baselineAcceptRate),
    transcriptWeight: weightFor(decided, 'transcript', baselineAcceptRate),
    // A later start (positive delta) means less lead-in was wanted, and vice versa.
    leadInSec: clamp(DEFAULT_TASTE_ADJUSTMENTS.leadInSec - editConfidence * startDelta, LEAD_IN_MIN, LEAD_IN_MAX),
    leadOutSec: clamp(DEFAULT_TASTE_ADJUSTMENTS.leadOutSec + editConfidence * endDelta, LEAD_OUT_MIN, LEAD_OUT_MAX)
  }
}

/** Whether there is enough history for the review screen to mention it. */
export function hasEnoughHistory(history: TasteDecision[]): boolean {
  return history.filter((d) => d.status === 'accepted' || d.status === 'rejected').length >= TUNED_AT_DECISIONS
}
