// GPU builds that only make a step faster (the work still runs without them,
// on the CPU or another backend). An app update can add one for hardware that
// was already set up, so a PC that needs one it does not have yet gets it
// fetched in the background, no click and no trip back to the setup screen.
// Pure so the decision is unit-tested without touching disk.

import type { HardwareProfile } from '@shared/types'
import { artifact, type ToolId } from './manifest'

interface Accelerator {
  id: ToolId
  /** Only worth fetching when this is installed too (e.g. a faster build of an optional tool). */
  requires?: ToolId
}

const ACCELERATORS: readonly Accelerator[] = [
  { id: 'whisper-vulkan' },
  // The language model is optional: only a PC that installed it gets its CUDA build.
  { id: 'llama-cuda', requires: 'llama' },
  { id: 'llama-cuda-runtime', requires: 'llama' }
]

/** Accelerators this PC needs but does not have yet. */
export function acceleratorsToFetch(hw: HardwareProfile, isInstalled: (id: ToolId) => boolean): ToolId[] {
  return ACCELERATORS.filter((a) => artifact(a.id).needed(hw) && !isInstalled(a.id) && (!a.requires || isInstalled(a.requires))).map((a) => a.id)
}
