// What the auto edit's rule engine (`main/core/editPlan.ts`) decided for one
// clip, kept on the clip so the next screens (variants, per-platform export)
// can read it instead of recomputing. Plain data only, no behaviour: the rules
// and their thresholds live in `main/core/editRules.ts`. Every field is
// optional on `Clip` (`editPlan?`), so a clip saved before this existed just
// has none until the plan is next computed.

/**
 * The shortest a finished clip may be, in seconds. Lives here (not in
 * `main/core/editRules.ts`, which reads it into `EDIT_RULES`) because Review's
 * trim handles stop at it too.
 */
export const FINAL_FLOOR_SEC = 10

export const PLATFORMS = ['tiktok', 'shorts', 'reels'] as const
export type Platform = (typeof PLATFORMS)[number]

/** A piece of the clip's own cut, in clip-relative seconds (0 = the cut's start), in output order. */
export interface PlanSegment {
  srcStart: number
  srcEnd: number
}

export interface CapFit {
  capSec: number
  fits: boolean
}

export type PlatformCapFit = Record<Platform, CapFit>

/** What the local language model said about a cold open, or `unavailable` when none ran (the stricter no-LLM gate then applies). */
export type ColdOpenLlmVerdict = 'confirmed' | 'rejected' | 'unavailable'

export interface ColdOpenPlan {
  qualifies: boolean
  /** 0..1, how well chat, loudness and the transcript agree on the payoff. */
  confidence: number
  llm: ColdOpenLlmVerdict
  /** Where the payoff sits, VOD seconds; lets a later re-plan reuse the LLM verdict while the payoff has not moved. */
  payoffVodSec: number | null
  /** Length of the payoff preview shown first; 0 when it does not qualify. */
  previewSec: number
  /** Final length of the cold-open version; 0 when it does not qualify. */
  finalSec: number
  /** The cold-open version as segments: the preview first, then the straight edit. Empty when it does not qualify. */
  segments: PlanSegment[]
  capFit: PlatformCapFit
  /** Short plain notes (why it qualified or did not), for the log. */
  reasons: string[]
}

export interface LoopPlan {
  /** Every loop rule passed: final length, quiet tail and seam. */
  eligible: boolean
  /** The clip-relative second the looped version ends at (last word plus its quiet), or null when there is no candidate. */
  endSec: number | null
  /** First against last frame, 0..1; null until measured at edit time. */
  seamScore: number | null
  /** Loudness step across the seam in dB (an RMS approximation of LU); null until measured. */
  loudnessDiffLu: number | null
  /** Quiet after the last word, seconds. */
  quietSec: number | null
  /** The frame threshold is a starting value nobody has measured against real clips yet. */
  calibrated: false
}

export interface ClipEditPlan {
  /** Length of the straight (non-cold-open) edit. */
  finalSec: number
  /** The 10 s floor made the pause and silence trimming get skipped for this clip. */
  editSkipped: boolean
  /** Seconds the cut was grown from its download padding to reach the floor. */
  extendedSec: number
  /** The clip could not reach the floor even with all of that. */
  belowFloor: boolean
  capFit: PlatformCapFit
  coldOpen: ColdOpenPlan
  loop: LoopPlan
}
