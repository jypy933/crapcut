// Bridges a stored `Clip` to `structureSignals.ts`'s `ClipFacts`, and picks
// the automatic viral-edit structure for one without the language model --
// cheap enough to call after every trim in review, unlike the LLM-aided pick
// the moments step makes once (`structureLlm.pickStructureWithLlm`). Pure: no
// I/O, no processes.

import type { Clip, Word } from '@shared/types'
import type { StructureDecision } from '@shared/structure'
import { pickStructure, type LlmChoice } from './structurePick'
import { computeSignals, type ClipFacts } from './structureSignals'

/**
 * `ClipFacts` for a stored clip's current cut. `loudness` is optional --
 * moments has the whole VOD's loudness handy and passes it; a lazy recompute
 * (a trim, or an old clip normalized on read) has no cheap way to get it, so
 * `computeSignals` falls back to chat or word emphasis instead.
 */
export function clipFacts(clip: Clip, loudness: Float64Array | null = null, loudnessOffset = 0): ClipFacts {
  return { window: { start: clip.start, end: clip.end }, words: clip.words, chatMessages: clip.chatMessages, loudness, loudnessOffset }
}

/** True if `span`'s words still fall entirely inside `window` (a trim may have cut into it). */
function spanStillInside(span: { start: number; end: number } | undefined, words: Word[], window: { start: number; end: number }): boolean {
  if (!span) return false
  const first = words[span.start]
  const last = words[span.end]
  return !!first && !!last && first.t0 >= window.start && last.t1 <= window.end
}

/**
 * Carries a previous decision's quote span, emphasis words and chat picks
 * forward as an `LlmChoice` hint, dropping anything that no longer lands
 * inside the (possibly trimmed) clip. `pickStructure` only actually uses the
 * hint when the previous structure is still a close-enough fit, so a trim
 * that changes the clip's shape is free to land on a different structure.
 */
function carryOverPicks(previous: StructureDecision | null | undefined, facts: ClipFacts): LlmChoice | undefined {
  if (!previous) return undefined
  const quoteSpan = spanStillInside(previous.quoteSpan, facts.words, facts.window) ? previous.quoteSpan : undefined
  const emphasisWords = (previous.emphasisWords ?? []).filter((i) => spanStillInside({ start: i, end: i }, facts.words, facts.window))
  const chatMessageIds = (previous.chatMessageIds ?? []).filter((i) => facts.chatMessages[i] !== undefined)
  if (!quoteSpan && emphasisWords.length === 0 && chatMessageIds.length === 0) return undefined
  return {
    structure: previous.structure,
    quoteSpan,
    emphasisWords: emphasisWords.length > 0 ? emphasisWords : undefined,
    chatMessageIds: chatMessageIds.length > 0 ? chatMessageIds : undefined
  }
}

/**
 * The heuristic structure decision for a clip's current cut -- no language
 * model. `previous` (the clip's last decision, if any) has its text picks
 * carried forward when they still fit; pass it whenever one exists, such as
 * after a trim.
 */
export function decideStructureHeuristically(clip: Clip, loudness: Float64Array | null = null, loudnessOffset = 0, previous?: StructureDecision | null): StructureDecision {
  const facts = clipFacts(clip, loudness, loudnessOffset)
  const signals = computeSignals(facts)
  const carried = carryOverPicks(previous, facts)
  return pickStructure(signals, facts.words, facts.window.start, carried)
}
