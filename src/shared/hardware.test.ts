import { describe, expect, it } from 'vitest'
import { canRunBigLlm, LLM_BIG_MIN_VRAM_MB, needsClipCaptionPass } from './hardware'
import type { HardwareProfile } from './types'

const base: HardwareProfile = { gpus: [], primary: null, whisper: 'cpu', llm: 'cpu', totalRamMb: 16384, cpuThreads: 8 }

describe('canRunBigLlm', () => {
  it('needs Vulkan and enough VRAM', () => {
    expect(canRunBigLlm({ ...base, llm: 'cpu' })).toBe(false)
    expect(canRunBigLlm({ ...base, llm: 'vulkan', primary: { vendor: 'amd', name: 'x', vramMb: LLM_BIG_MIN_VRAM_MB - 1 } })).toBe(false)
    expect(canRunBigLlm({ ...base, llm: 'vulkan', primary: { vendor: 'amd', name: 'x', vramMb: LLM_BIG_MIN_VRAM_MB } })).toBe(true)
  })
})

describe('needsClipCaptionPass', () => {
  it('is only true on the CPU whisper path (NVIDIA already used the large model on the whole VOD)', () => {
    expect(needsClipCaptionPass({ whisper: 'cpu' })).toBe(true)
    expect(needsClipCaptionPass({ whisper: 'cuda' })).toBe(false)
  })
})
