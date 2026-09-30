// The rule engine for the automatic edit: takes a clip's facts and structure
// decision and returns the straight edit, the cold-open version's plan, the
// loop plan and every rule's result, all through the pure checks in
// `editRules.ts`, `coldOpen.ts` and `loopSeam.ts`. Pure: measuring frames and
// loudness at edit time is `pipeline/seamMeasure.ts`; what this needs from
// them comes in through `PlanInput`. It builds on `buildViralEdit` and never
// re-implements structure or pacing logic.
//
// Order when an edit would end up under the final-length floor: skip the edit
// (keep the whole cut), then grow the cut from its download padding, then give
// up on the clip (`drop`) only if it is still short.

import type { ClipEditPlan, ColdOpenLlmVerdict, HookGrade } from '@shared/editPlan'
import type { Range, Word } from '@shared/types'
import { coldOpenVariantEdl, buildViralEdit, clipRelativeWords, type PacingStats, type ViralEditOptions } from './viralEdit'
import { planColdOpen } from './coldOpen'
import {
  capFit,
  checkContent,
  checkHook,
  checkLength,
  checkPacing,
  contentCoverage,
  countChatPeaks,
  EDIT_RULES,
  envelopeFromLoudness,
  frameZeroIsContent,
  perSecondLoudness,
  shiftEnvelope,
  type CheckResult,
  type Envelope
} from './editRules'
import { outputDuration, sourceToOutputTime, type Edl } from './edl'
import { checkLoop, planLoopEnd, seamCrossfadeSec, seamPasses, type SeamMeasure } from './loopSeam'
import type { StructureDecision } from './structurePick'
import { chatSeries, computeSignals, type ClipFacts } from './structureSignals'

/** A little over the floor, so a cut grown to it does not land a hair under it after rounding. */
const EXTEND_MARGIN_SEC = 0.05
/** The last frame of a looped edit is read this far before its end, so it is a real frame and not past the last one. */
const SEAM_LAST_FRAME_BACKOFF_SEC = 0.05

/** A previous language-model verdict on the cold open still holds while the payoff has moved no more than this. */
const LLM_VERDICT_REUSE_SEC = 1.5

export interface PlanInput {
  /** `facts.window` is the cut as it stands; `facts.words` and `chatMessages` cover the padding too. */
  facts: ClipFacts
  decision: StructureDecision
  /** How far the cut may grow: the downloaded range, or the padding it will get. VOD seconds. */
  bounds: Range
  options?: ViralEditOptions
  /** A finer loudness envelope measured from the downloaded clip (VOD seconds); the job's per-second log is used without it. */
  envelope?: Envelope | null
  /** Frame and loudness match across the loop seam, measured at edit time; without it a loop cannot be judged eligible. */
  seam?: SeamMeasure | null
  /** What the local language model said about the cold open, when it ran. */
  llm?: ColdOpenLlmVerdict
  /**
   * The clip's plan from an earlier pass. Its language-model verdict is kept
   * while the payoff has not moved, so a re-plan (a trim, a preview) never
   * needs the model again.
   */
  previous?: ClipEditPlan
  /** The clip was picked for a strong loudness peak (`isLoudPeak` on its stored audioZ): it passes the content floor without a chat peak. */
  loudPeak?: boolean
  /** The clip was found from the transcript (`signals.source`): it has no chat peak by construction and passes that half of the content floor. */
  transcriptMoment?: boolean
}

export interface PlanResult {
  /** The cut after any growth from the padding; VOD seconds. */
  window: Range
  /** The straight edit. Ends in a loop only when the structure asks for one and the seam passed. */
  edl: Edl
  /** The second version, or null when the clip does not qualify. */
  coldOpenEdl: Edl | null
  plan: ClipEditPlan
  /** One per rule, for the log (`formatCheckLine`). */
  checks: CheckResult[]
  /** Still under the floor after skipping the edit and growing the cut: the caller drops the clip where it can. */
  drop: boolean
  /** The content floor held (a peak inside: chat, loud or a transcript moment; speech or loud frames over 40%). */
  contentOk: boolean
  /** Where the seam should be measured when a loop is possible but no measurement was given yet; clip-relative seconds. */
  seamProbe: { window: Range; firstSec: number; lastSec: number; endSec: number; speechEndSec: number; words: Word[] } | null
}

/** Grows `window` by up to `need` seconds at its end only, as far as `bounds` allow. */
export function growEnd(window: Range, bounds: Range, need: number): Range {
  const room = Math.max(0, bounds.end - window.end)
  return { start: window.start, end: window.end + Math.min(need, room) }
}

/** Grows `window` by up to `need` seconds inside `bounds`, half each side, shifting what one side cannot give to the other. */
export function growWindow(window: Range, bounds: Range, need: number): Range {
  const roomBefore = Math.max(0, window.start - bounds.start)
  const roomAfter = Math.max(0, bounds.end - window.end)
  const total = Math.max(0, Math.min(need, roomBefore + roomAfter))
  const after = Math.min(roomAfter, Math.max(total / 2, total - roomBefore))
  const before = Math.min(roomBefore, total - after)
  return { start: window.start - before, end: window.end + after }
}

export function planAutoEdit(input: PlanInput): PlanResult {
  const { decision, bounds } = input
  const options = input.options ?? {}
  const env = input.envelope ?? envelopeFromLoudness(input.facts.loudness, input.facts.loudnessOffset)
  // At edit time the clip's own loudness stands in for the job's log, so the
  // peak found here is the one the structure decision was made on.
  const facts: ClipFacts = input.facts.loudness || !env ? input.facts : { ...input.facts, loudness: perSecondLoudness(env), loudnessOffset: env.startSec }
  const floor = EDIT_RULES.length.finalFloorSec

  type Mode = 'full' | 'plain' | 'hook'
  const build = (window: Range, mode: Mode, loop: ViralEditOptions['loop'] = null): { edl: Edl; stats: PacingStats; final: number } => {
    const built = buildViralEdit(decision, { ...facts, window }, { ...options, envelope: env, plain: mode === 'plain', hookOnly: mode === 'hook', loop })
    return { ...built, final: outputDuration(built.edl) }
  }

  // The floor, in the owner's order: skip the edit, then grow the cut, then drop.
  // One exception: a long silent opening (first speech or reaction past the hard
  // hook limit) is cut anyway and the END is grown from the padding instead, so
  // the clip does not open on dead air. If the padding cannot cover it, the
  // usual order is tried before the clip is given up on.
  let window = facts.window
  let mode: Mode = 'full'
  let extendedSec = 0
  let built = build(window, 'full')
  if (built.final < floor - 1e-6) {
    const first = built.stats.firstEventSec
    if (first !== null && first > EDIT_RULES.hook.hardSec) {
      const hook = build(window, 'hook')
      const grown = hook.final < floor - 1e-6 ? growEnd(window, bounds, floor - hook.final + EXTEND_MARGIN_SEC) : window
      const regrown = grown === window ? hook : build(grown, 'hook')
      if (regrown.final >= floor - 1e-6) {
        mode = 'hook'
        window = grown
        extendedSec = grown.end - facts.window.end
        built = regrown
      }
    }
    if (mode === 'full') {
      mode = 'plain'
      built = build(window, 'plain')
      if (built.final < floor - 1e-6) {
        const grown = growWindow(window, bounds, floor - built.final + EXTEND_MARGIN_SEC)
        extendedSec = grown.end - grown.start - (window.end - window.start)
        window = grown
        built = build(window, 'plain')
      }
    }
  }
  const plain = mode === 'plain'
  const belowFloor = built.final < floor - 1e-6

  const clipLength = window.end - window.start
  const words = clipRelativeWords({ ...facts, window })
  const envRel = shiftEnvelope(env, window.start)
  const signals = computeSignals({ ...facts, window })
  const peakSec = signals.setupLength
  const straight = built

  // Loop: a candidate from the words and audio; eligible once the seam is measured and passes.
  const loopPlan = plain ? { candidate: null, reason: 'the edit was skipped for the length floor' } : planLoopEnd({ words, segments: straight.edl.segments, clipLength, peakSec, env: envRel })
  const seam = input.seam ?? null
  const eligible = !!loopPlan.candidate && !!seam && seamPasses(seam)
  let final = straight
  if (loopPlan.candidate && eligible && decision.loopEnding) {
    final = build(window, mode, { endSec: loopPlan.candidate.endSec, crossfadeSec: seamCrossfadeSec(loopPlan.candidate.finalSec) })
  }

  // Content floor, on the edit as it will be.
  const series = chatSeries({ ...facts, window }, Math.max(1, Math.ceil(clipLength)))
  const chatPeaks = facts.chatMessages.length === 0 ? null : countChatPeaks(series)
  const coverage = contentCoverage(final.edl.segments, words, envRel, { from: 0, to: clipLength })
  const content = checkContent(chatPeaks, coverage, input.loudPeak === true, input.transcriptMoment === true)

  // Hook.
  const first = final.stats.firstEventSec
  const firstOut = first === null ? null : sourceToOutputTime(final.edl.segments, final.edl.freeze, Math.max(first, final.edl.segments[0]!.srcStart), false)
  const hook = checkHook(firstOut, frameZeroIsContent(final.edl))

  // Cold open, planned on the straight (non-loop) edit.
  let chatPeak: { sec: number; weight: number } | null = null
  if (series && facts.chatMessages.length > 0) {
    let best = 0
    for (let i = 1; i < series.length; i++) if (series[i]! > series[best]!) best = i
    if (series[best]! > 0) chatPeak = { sec: best, weight: series[best]! }
  }
  const payoffVodSec = window.start + peakSec
  const carried = input.previous?.coldOpen
  const llm = input.llm ?? (carried && carried.payoffVodSec !== null && Math.abs(carried.payoffVodSec - payoffVodSec) <= LLM_VERDICT_REUSE_SEC ? carried.llm : 'unavailable')
  const cold = planColdOpen({ words, segments: straight.edl.segments, peakSec, chatPeak, env: envRel, llm, payoffVodSec })
  const coldOpenEdl = coldOpenVariantEdl(straight.edl, cold, options)

  const plan: ClipEditPlan = {
    finalSec: final.final,
    editSkipped: plain,
    extendedSec,
    belowFloor,
    capFit: capFit(final.final),
    coldOpen: cold,
    loop: {
      eligible,
      endSec: loopPlan.candidate?.endSec ?? null,
      seamScore: seam?.frameSimilarity ?? null,
      loudnessDiffLu: seam?.loudnessDiffLu ?? null,
      quietSec: loopPlan.candidate?.quietSec ?? null,
      calibrated: true
    },
    hook: { grade: hook.values.grade as HookGrade, pass: hook.status === 'pass' },
    content: { pass: content.status !== 'fail', coverage }
  }

  const checks: CheckResult[] = [
    checkLength(final.final, { editSkipped: plain, extendedSec }),
    content,
    hook,
    checkPacing(final.edl, words, final.stats),
    {
      check: 'coldOpen',
      status: cold.qualifies ? 'pass' : cold.reasons.some((r) => /payoff|setup/.test(r)) ? 'na' : 'fail',
      values: { qualifies: cold.qualifies, confidence: cold.confidence, llm: cold.llm, preview: cold.previewSec, final: cold.finalSec, why: cold.reasons.join('; ') }
    },
    checkLoop(loopPlan.candidate, loopPlan.reason, seam, decision.loopEnding)
  ]

  const seamProbe =
    loopPlan.candidate && !seam
      ? {
          window,
          firstSec: straight.edl.segments[0]!.srcStart,
          lastSec: Math.max(0, loopPlan.candidate.endSec - SEAM_LAST_FRAME_BACKOFF_SEC),
          endSec: loopPlan.candidate.endSec,
          // The speech level is read from the first word of the edit to where the last word's sound ends, not into the quiet the loop ends on.
          speechEndSec: loopPlan.candidate.speechEndSec,
          words
        }
      : null

  return { window, edl: final.edl, coldOpenEdl, plan, checks, drop: belowFloor, contentOk: content.status !== 'fail', seamProbe }
}
