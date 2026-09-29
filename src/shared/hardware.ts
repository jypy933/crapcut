// Small hardware rules shared by the main process (which model to fetch) and
// the renderer (which model a settings screen offers, without duplicating the
// number).

import type { HardwareProfile } from './types'

/** Enough VRAM for the bigger language model (Q4) plus context. */
export const LLM_BIG_MIN_VRAM_MB = 7000

/** Whether this machine's GPU can run the bigger language model. */
export function canRunBigLlm(hw: HardwareProfile): boolean {
  return hw.llm === 'vulkan' && (hw.primary?.vramMb ?? 0) >= LLM_BIG_MIN_VRAM_MB
}

/**
 * Whether the chosen clips are worth a second, slower pass for cleaner
 * captions, because some of the VOD was transcribed with the fast, less
 * accurate model. NVIDIA machines already transcribe the whole VOD with the
 * large model. On Vulkan the large model runs on the GPU too, so the pass is
 * only needed when part of the VOD fell back to the CPU (`allSharp` is false:
 * a chunk that ran on the CPU, or one with no record of where it ran).
 */
export function needsClipCaptionPass(hw: Pick<HardwareProfile, 'whisper'>, allSharp: boolean): boolean {
  if (hw.whisper === 'cuda') return false
  if (hw.whisper === 'vulkan') return !allSharp
  return true
}
