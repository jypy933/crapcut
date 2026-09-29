// Small hardware rules shared by the main process (which model to fetch) and
// the renderer (which model a settings screen offers, without duplicating the
// number).

import type { HardwareProfile } from './types'

/** Enough VRAM for the 8B language model (Q4) plus context. */
export const LLM_8B_MIN_VRAM_MB = 7000

/** Whether this machine's GPU can run the bigger language model. */
export function canRunBigLlm(hw: HardwareProfile): boolean {
  return hw.llm === 'vulkan' && (hw.primary?.vramMb ?? 0) >= LLM_8B_MIN_VRAM_MB
}
