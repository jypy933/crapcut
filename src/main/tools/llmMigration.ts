// When a newer pinned language model replaces an older one for the same
// hardware tier (Ministral 3 8B -> Qwen3.5 9B), an existing install of the
// old one should keep working until the new one is fully downloaded and
// verified, and only then be cleaned up. Pure so the decision is unit-tested
// without touching disk; `tools/setup.ts` calls it after a download run.

import { canRunBigLlm } from '@shared/hardware'
import type { HardwareProfile } from '@shared/types'
import type { ToolId } from './manifest'

/** The big-tier language model retired by a newer pinned one, and its replacement. */
const RETIRED_BIG_LLM: ToolId = 'model-llm-8b'
const CURRENT_BIG_LLM: ToolId = 'model-llm-9b'

/**
 * Legacy language model artifacts safe to remove now: only once this
 * hardware maps to the big tier, the new pinned model for it is fully
 * installed, and the old one is still on disk from before the swap. Empty
 * otherwise, including while the new model is still downloading -- the old
 * one is the only thing keeping the moments step smart until then.
 */
export function legacyLlmToRemove(hw: HardwareProfile, isInstalled: (id: ToolId) => boolean): ToolId[] {
  if (!canRunBigLlm(hw)) return []
  if (!isInstalled(CURRENT_BIG_LLM)) return []
  if (!isInstalled(RETIRED_BIG_LLM)) return []
  return [RETIRED_BIG_LLM]
}

/**
 * Whether this PC should be offered an automatic, no-click download of the
 * new big-tier model: it already has the old one installed (from before this
 * swap shipped) and hasn't fetched the replacement yet. A PC with neither
 * installed just gets the new one the normal way, from the setup screen.
 */
export function shouldAutoFetchReplacement(hw: HardwareProfile, isInstalled: (id: ToolId) => boolean): boolean {
  return canRunBigLlm(hw) && isInstalled(RETIRED_BIG_LLM) && !isInstalled(CURRENT_BIG_LLM)
}
