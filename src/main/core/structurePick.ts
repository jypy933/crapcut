// Scores every re-edit structure against one clip's signals and picks one.
// Pure and deterministic; the optional LLM tie-break (`structureLlm.ts`) only
// ever narrows a choice between structures this module already scored, and
// only supplies indices into data this module was given -- it never invents
// on-screen text.

import type { Word } from '@shared/types'
import { isKeywordWord } from '@shared/captions'
import { STRUCTURES, type LlmChoice, type StructureDecision, type StructureId, type WordSpan } from '@shared/structure'
import type { StructureSignals } from './structureSignals'

export { STRUCTURES }
export type { LlmChoice, StructureDecision, StructureId, WordSpan }

export interface StructureScore {
  structure: StructureId
  /** 0..1, higher is a better fit. Not normalised across structures to sum to 1: they are independent fits, not a distribution. */
  score: number
  reasons: string[]
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

const TIGHT_CUT_SCORE = 0.2

const PAYOFF_PEAK_RATIO_MAX = 0.15
const PAYOFF_SETUP_MAX_SEC = 3

const BUILD_PEAK_RATIO_MIN = 0.15
const BUILD_PEAK_RATIO_MAX = 0.4
/** A ramp to punch, not a scatter of comparable beats -- that is rapidFire's job. */
const BUILD_MAX_SUBPEAKS = 2

/** "Short or medium": long enough to need review but short enough that a single verbatim line still frames the whole clip. */
const QUOTE_MAX_CLIP_SEC = 40

const CHAT_FIRST_MIN_RATIO = 1.5
const CHAT_FIRST_MIN_LEAD_SEC = 2

const RAPID_FIRE_MIN_SUBPEAKS = 3

const FREEZE_PEAK_RATIO_MIN = 0.8
/** A freeze-loop needs the clip to not trail off into dead air after the peak, or looping it back to the start feels broken. */
const FREEZE_MAX_TAIL_SILENCE = 0.5

const QUOTE_LOOP_PEAK_RATIO_MIN = 0.7

/**
 * Every structure's fit for these signals, independently scored with short
 * reasons. Starting rules (tune here, keep documented):
 * - payoffFirst: the peak is in the first 15% of the clip with under 3 s of
 *   setup -- there is barely any build-up worth keeping before it.
 * - buildAndPunch: the peak sits in the 15-40% range with one dominant ramp
 *   (few comparable sub-peaks), rather than several roughly-equal beats.
 * - quoteCard: a clean 3-8 word line exists near the peak and the clip is
 *   short or medium, so a single verbatim line can frame the whole thing;
 *   scores higher still when that line sits right at the peak and the peak
 *   is late (>70%), which also turns on the loop ending.
 * - chatFirst: chat's own burst clearly outruns the streamer's speech near
 *   the peak (rate) and leads it by more than 2 s -- experimental, so it is
 *   capped well below the others even at its best.
 * - rapidFire: three or more comparable beats, no one of them dominant.
 * - freezeLoop: the peak sits in the last 20% of the clip and it does not
 *   trail into dead air afterwards, so looping the end back to the start
 *   reads as intentional rather than cut off.
 * - tightCut: the default; scores enough to win only when nothing else fits.
 */
export function scoreStructures(signals: StructureSignals): StructureScore[] {
  const out: StructureScore[] = []

  {
    const reasons: string[] = []
    let score = 0
    if (signals.peakRatio < PAYOFF_PEAK_RATIO_MAX && signals.setupLength < PAYOFF_SETUP_MAX_SEC) {
      score = 0.75 + 0.2 * (1 - signals.peakRatio / PAYOFF_PEAK_RATIO_MAX)
      reasons.push('the reaction lands almost immediately, with barely any build-up to keep')
    }
    out.push({ structure: 'payoffFirst', score: clamp01(score), reasons })
  }

  {
    const reasons: string[] = []
    let score = 0
    if (signals.peakRatio >= BUILD_PEAK_RATIO_MIN && signals.peakRatio <= BUILD_PEAK_RATIO_MAX && signals.subPeaks <= BUILD_MAX_SUBPEAKS) {
      const mid = (BUILD_PEAK_RATIO_MIN + BUILD_PEAK_RATIO_MAX) / 2
      score = 0.55 + 0.25 * (1 - Math.abs(signals.peakRatio - mid) / (mid - BUILD_PEAK_RATIO_MIN))
      reasons.push('a single build-up leads into the payoff, worth pushing into and snapping on')
    }
    out.push({ structure: 'buildAndPunch', score: clamp01(score), reasons })
  }

  {
    const reasons: string[] = []
    let score = 0
    const hasSpan = signals.quotableSpans.length > 0
    if (hasSpan && signals.clipLength <= QUOTE_MAX_CLIP_SEC) {
      score = 0.5
      reasons.push('a clean verbatim line sits near the peak')
      if (signals.peakRatio > QUOTE_LOOP_PEAK_RATIO_MIN) {
        score = 0.85
        reasons.push('that line is right at a late peak, worth opening on and looping back to')
      }
    }
    out.push({ structure: 'quoteCard', score: clamp01(score), reasons })
  }

  {
    const reasons: string[] = []
    let score = 0
    if (signals.chatRateRatio >= CHAT_FIRST_MIN_RATIO && signals.chatLeadSec > CHAT_FIRST_MIN_LEAD_SEC) {
      // Experimental and scored conservatively: capped well under the others.
      score = 0.4 + Math.min(0.1, signals.chatLeadSec / 100)
      reasons.push('chat visibly reacted before the payoff itself, worth showing first (experimental)')
    }
    out.push({ structure: 'chatFirst', score: clamp01(score), reasons })
  }

  {
    const reasons: string[] = []
    let score = 0
    if (signals.subPeaks >= RAPID_FIRE_MIN_SUBPEAKS) {
      score = 0.6 + Math.min(0.25, (signals.subPeaks - RAPID_FIRE_MIN_SUBPEAKS) * 0.08)
      reasons.push(`${signals.subPeaks} comparable beats, no single one dominant`)
    }
    out.push({ structure: 'rapidFire', score: clamp01(score), reasons })
  }

  {
    const reasons: string[] = []
    let score = 0
    if (signals.peakRatio > FREEZE_PEAK_RATIO_MIN && signals.silenceRatio < FREEZE_MAX_TAIL_SILENCE) {
      score = 0.65 + 0.2 * (signals.peakRatio - FREEZE_PEAK_RATIO_MIN) / (1 - FREEZE_PEAK_RATIO_MIN)
      reasons.push('the reaction lands right at the end and the clip is self-contained enough to loop')
    }
    out.push({ structure: 'freezeLoop', score: clamp01(score), reasons })
  }

  out.push({ structure: 'tightCut', score: TIGHT_CUT_SCORE, reasons: ['plain cut, nothing else stood out'] })

  return out
}

/** Word indices satisfying `isKeywordWord` within `span` of `words` (or the whole array with no span). */
function emphasisIn(words: Word[], span: WordSpan | undefined): number[] {
  const lo = span ? span.start : 0
  const hi = span ? span.end : words.length - 1
  const out: number[] = []
  for (let i = Math.max(0, lo); i <= Math.min(words.length - 1, hi); i++) if (isKeywordWord(words[i]!.text)) out.push(i)
  return out
}

/** Word span of everything within `radiusSec` of `atSec` (clip-relative), or undefined if nothing is close. */
function wordsNear(words: Word[], clipStartSec: number, atSec: number, radiusSec: number): WordSpan | undefined {
  const target = clipStartSec + atSec
  let start = -1
  let end = -1
  for (let i = 0; i < words.length; i++) {
    if (Math.abs(words[i]!.t0 - target) <= radiusSec || Math.abs(words[i]!.t1 - target) <= radiusSec) {
      if (start === -1) start = i
      end = i
    }
  }
  return start === -1 ? undefined : { start, end }
}

/** How close two scores need to be to count as a tie worth asking the LLM about, or for an LLM answer to be honoured over the heuristic top pick. */
export const TIE_MARGIN = 0.08

/**
 * Builds the final decision: which structure, its loop/hook/quote/emphasis
 * fields, and why. `signals` alone always produces a decision; `llmChoice`
 * (already validated by `structureLlm.parseStructureAnswer`) only takes over
 * when it names a structure that was genuinely close to the heuristic top
 * pick, so a stale or overly confident model answer can never override a
 * clear-cut signal.
 *
 * `words` (the clip's own caption words) is needed to compute emphasis
 * indices; pass the same array `computeSignals` was given so the returned
 * word indices line up.
 */
export function pickStructure(signals: StructureSignals, words: Word[], clipStartSec = 0, llmChoice?: LlmChoice): StructureDecision {
  const scored = scoreStructures(signals)
  const ranked = [...scored].sort((a, b) => b.score - a.score)
  let winner = ranked[0]!

  if (llmChoice) {
    const chosen = scored.find((s) => s.structure === llmChoice.structure)
    if (chosen && winner.score - chosen.score <= TIE_MARGIN) winner = chosen
  }

  // computeSignals only ever returns spans within QUOTE_RADIUS_SEC of the
  // peak, so the closest one (index 0) already qualifies as "at the peak".
  const quoteAtPeak = signals.quotableSpans.length > 0 && signals.peakRatio > QUOTE_LOOP_PEAK_RATIO_MIN

  const decision: StructureDecision = { structure: winner.structure, loopEnding: false, emphasisWords: [], reasons: winner.reasons }

  switch (winner.structure) {
    case 'payoffFirst': {
      const radius = 1
      decision.coldOpenSpan = { start: Math.max(0, signals.setupLength - radius), end: signals.setupLength + radius }
      decision.hookSpan = wordsNear(words, clipStartSec, signals.setupLength, radius)
      decision.emphasisWords = emphasisIn(words, decision.hookSpan)
      break
    }
    case 'quoteCard': {
      const span = llmChoice?.quoteSpan ?? signals.quotableSpans[0]
      decision.quoteSpan = span
      decision.emphasisWords = llmChoice?.emphasisWords ?? emphasisIn(words, span)
      if (span && quoteAtPeak) decision.loopEnding = true
      break
    }
    case 'buildAndPunch': {
      const peakSpan = wordsNear(words, clipStartSec, signals.setupLength, 1.5)
      decision.emphasisWords = emphasisIn(words, peakSpan)
      break
    }
    case 'chatFirst': {
      decision.emphasisWords = llmChoice?.emphasisWords ?? []
      if (llmChoice?.chatMessageIds) decision.chatMessageIds = llmChoice.chatMessageIds
      break
    }
    case 'freezeLoop': {
      decision.loopEnding = true
      const peakSpan = wordsNear(words, clipStartSec, signals.setupLength, 1.5)
      decision.emphasisWords = emphasisIn(words, peakSpan)
      break
    }
    case 'rapidFire':
    case 'tightCut':
    default:
      break
  }

  return decision
}
