// Types for the automatic viral-edit structure decision. Defined here (not in
// `main/core/structurePick.ts`, which owns the actual picking logic) because a
// clip's chosen structure is stored on `Clip` and crosses into the renderer;
// `structurePick.ts` and `structureSignals.ts` import these same types back
// from here so there is exactly one definition.

export const STRUCTURES = ['tightCut', 'payoffFirst', 'quoteCard', 'buildAndPunch', 'rapidFire', 'freezeLoop', 'chatFirst'] as const
export type StructureId = (typeof STRUCTURES)[number]

/** A span as word indices into a clip's own `words` array, start and end inclusive. */
export interface WordSpan {
  start: number
  end: number
}

export interface StructureDecision {
  structure: StructureId
  loopEnding: boolean
  /** Word span for on-screen text shown during a cold open (payoffFirst). */
  hookSpan?: WordSpan
  /** Source (VOD-second) range of the cold-open replay, 1-2 s around the peak (payoffFirst). */
  coldOpenSpan?: { start: number; end: number }
  /** The verbatim line shown in the quote card's top bar (quoteCard). */
  quoteSpan?: WordSpan
  /** Word indices worth calling out in captions (shouted/numeric/excited words near the chosen span, or near the peak with no span). */
  emphasisWords: number[]
  /** Indices into the clip's chat messages that made up the reaction chat drove this pick (chatFirst, or any structure with a real chat burst behind it). */
  chatMessageIds?: number[]
  reasons: string[]
}

/** A validated LLM tie-break answer -- see `main/core/structureLlm.ts`. */
export interface LlmChoice {
  structure: StructureId
  quoteSpan?: WordSpan
  emphasisWords?: number[]
  chatMessageIds?: number[]
}
