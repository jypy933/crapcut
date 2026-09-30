// Plans the cold-open version of a clip: a short preview of the payoff and its
// reaction shown first, then a hard cut back to the start of the straight
// edit. Pure and deterministic. It qualifies only when the chat peak, the
// loudness peak and the transcript all agree there is a payoff worth showing
// early; the local language model, when present, confirms (a lower bar), and
// without it the deterministic gate is stricter. Nothing is invented: the
// preview is the clip's own footage, cut on word boundaries.
//
// `buildViralEdit` never applies this to the straight edit -- the plan is
// stored on the clip and `viralEdit.coldOpenVariantEdl` builds the second
// version from it. A clip whose payoff is already in the first 3 s or first
// 15% (the `payoffFirst` structure) never qualifies: it already opens on the
// payoff.

import type { Word } from '@shared/types'
import type { ColdOpenLlmVerdict, ColdOpenPlan, PlanSegment } from '@shared/editPlan'
import { capFit, EDIT_RULES, maxDb, medianDb, type Envelope } from './editRules'
import { concatDuration, sourceToOutputTime, type EdlSegment } from './edl'
import { remapWordsToEdl } from './edlCaptions'

export interface ColdOpenInputs {
  /** The clip's words, clip-relative seconds. */
  words: Word[]
  /** Segments of the straight edit, clip-relative source seconds. */
  segments: EdlSegment[]
  /** The payoff, clip-relative seconds. */
  peakSec: number
  /** The chat burst's own peak (clip-relative seconds) and its distinct-chatter weight; null without chat. */
  chatPeak: { sec: number; weight: number } | null
  /** Clip-relative loudness, or null. */
  env: Envelope | null
  llm: ColdOpenLlmVerdict
  /** The payoff in VOD seconds, kept on the plan so a later re-plan can reuse the LLM verdict. */
  payoffVodSec: number
}

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))

function notQualified(inputs: ColdOpenInputs, confidence: number, reasons: string[]): ColdOpenPlan {
  return { qualifies: false, confidence, llm: inputs.llm, payoffVodSec: inputs.payoffVodSec, previewSec: 0, finalSec: 0, segments: [], capFit: capFit(0), reasons }
}

/**
 * The preview span (clip-relative): starts `previewLeadSec` before the payoff
 * at the first word still sounding then (with `keepSec` of air before it),
 * runs `previewTailSec` past it, and ends on a word boundary so no word is cut.
 * Trimmed toward the preferred 3 s when the words allow, capped at 4 s and at
 * a share of the straight edit; null when it cannot be at least 1.5 s.
 */
export function previewSpan(words: Word[], peakSec: number, straightSec: number): PlanSegment | null {
  const { previewLeadSec, previewTailSec, previewMinSec, previewPreferredMaxSec, previewMaxSec, maxShareOfClip } = EDIT_RULES.coldOpen
  const keep = EDIT_RULES.hook.keepSec
  const cap = Math.min(previewMaxSec, straightSec * maxShareOfClip)
  if (cap < previewMinSec) return null

  const from = peakSec - previewLeadSec
  const firstWord = words.find((w) => w.t1 > from)
  const start = Math.max(0, firstWord ? Math.min(firstWord.t0, peakSec) - keep : from)

  const endAt = (target: number): number => {
    // Extend to the end of a word that is still sounding at the target, plus a little air.
    const sounding = words.find((w) => w.t0 < target && w.t1 > target)
    return sounding ? sounding.t1 + keep : target
  }
  let end = endAt(peakSec + previewTailSec)
  if (end - start > previewPreferredMaxSec) {
    // Prefer the shorter cut when a word boundary lets us: stop at the last word ending inside the preferred length.
    const short = words.filter((w) => w.t1 + keep - start <= previewPreferredMaxSec && w.t1 > peakSec).pop()
    if (short && short.t1 + keep - start >= previewMinSec) end = short.t1 + keep
  }
  if (end - start < previewMinSec) end = endAt(start + previewMinSec)
  if (end - start > cap + 1e-6) return null
  return { srcStart: start, srcEnd: end }
}

/** True when a word from the same source position shows up twice in the output within `withinSec` (a preview overlapping its own replay). */
export function repeatsWordWithin(segments: EdlSegment[], words: Word[], withinSec: number): boolean {
  const edl = { segments, zoom: [], freeze: [], overlays: [], sfx: [], ending: { kind: 'cut' as const } }
  const seen = new Map<number, number[]>()
  // One remap per word, so each source word's own output times can be compared.
  words.forEach((w, i) => {
    const out = remapWordsToEdl([w], edl)
    if (out.length > 1) seen.set(i, out.map((o) => o.t0))
  })
  for (const times of seen.values()) {
    const sorted = [...times].sort((a, b) => a - b)
    for (let k = 1; k < sorted.length; k++) if (sorted[k]! - sorted[k - 1]! < withinSec) return true
  }
  return false
}

export function planColdOpen(inputs: ColdOpenInputs): ColdOpenPlan {
  const c = EDIT_RULES.coldOpen
  const { words, segments, peakSec, chatPeak, env } = inputs
  const straightSec = concatDuration(segments)
  const reasons: string[] = []

  if (segments.length === 0 || straightSec <= 0) return notQualified(inputs, 0, ['no edit to open'])

  // Where the payoff lands in the straight edit, and how much setup leads to it.
  const payoffOut = sourceToOutputTime(segments, [], peakSec, false)
  if (payoffOut < c.skipPayoffFirstSec) return notQualified(inputs, 0, [`payoff at ${payoffOut.toFixed(1)}s is already in the first ${c.skipPayoffFirstSec}s`])
  if (payoffOut / straightSec < c.skipPayoffFirstRatio) return notQualified(inputs, 0, ['payoff is already in the first 15%'])
  if (payoffOut < c.setupMinSec) return notQualified(inputs, 0, [`setup ${payoffOut.toFixed(1)}s is under ${c.setupMinSec}s`])

  // The three signals must each be there and agree.
  const chatScore = chatPeak ? clamp01(chatPeak.weight / (2 * EDIT_RULES.content.chatPeakMinWeight)) : 0
  const chatPresent = !!chatPeak && chatPeak.weight >= EDIT_RULES.content.chatPeakMinWeight
  const chatAgrees = !!chatPeak && Math.abs(chatPeak.sec - c.chatDelaySec - peakSec) <= c.agreeToleranceSec

  const median = medianDb(env, 0, Infinity)
  const peakDb = env ? maxDb(env, peakSec - 1, peakSec + 2) : -Infinity
  const loudLift = median === null ? 0 : peakDb - median
  const loudPresent = loudLift >= c.loudPeakMinAboveMedianDb
  const loudScore = clamp01(loudLift / (2 * c.loudPeakMinAboveMedianDb))

  const span = previewSpan(words, peakSec, straightSec)
  const previewWords = span ? words.filter((w) => w.t0 >= span.srcStart - 1e-6 && w.t1 <= span.srcEnd + 1e-6).length : 0
  const wordsPresent = previewWords >= c.minPreviewWords
  const wordScore = clamp01(previewWords / (2 * c.minPreviewWords))

  const confidence = c.weights.chat * chatScore + c.weights.loud * loudScore + c.weights.words * wordScore
  if (!chatPresent) reasons.push('no chat peak')
  else if (!chatAgrees) reasons.push('chat peak is not at the payoff')
  if (!loudPresent) reasons.push('no loudness peak')
  if (!wordsPresent) reasons.push('too few words in the preview')
  if (!span) reasons.push('no preview of 1.5-4 s fits')
  if (reasons.length > 0) return notQualified(inputs, confidence, reasons)

  if (inputs.llm === 'rejected') return notQualified(inputs, confidence, ['the language model did not confirm it'])
  const needed = inputs.llm === 'confirmed' ? c.minConfidenceWithLlm : c.minConfidenceNoLlm
  if (confidence < needed) return notQualified(inputs, confidence, [`confidence ${confidence.toFixed(2)} is under ${needed}${inputs.llm === 'unavailable' ? ' (no language model)' : ''}`])

  const preview = span!
  const withPreview: EdlSegment[] = [{ srcStart: preview.srcStart, srcEnd: preview.srcEnd, speed: 1 }, ...segments]
  if (repeatsWordWithin(withPreview, words, c.noRepeatWithinSec)) return notQualified(inputs, confidence, ['a word would show twice within 2 s'])

  const previewSec = preview.srcEnd - preview.srcStart
  const finalSec = straightSec + previewSec
  return {
    qualifies: true,
    confidence,
    llm: inputs.llm,
    payoffVodSec: inputs.payoffVodSec,
    previewSec,
    finalSec,
    segments: [preview, ...segments.map((s) => ({ srcStart: s.srcStart, srcEnd: s.srcEnd }))],
    capFit: capFit(finalSec),
    reasons: [`setup ${payoffOut.toFixed(1)}s, preview ${previewSec.toFixed(1)}s, chat + loudness + words agree${inputs.llm === 'confirmed' ? ', model confirmed' : ''}`]
  }
}
