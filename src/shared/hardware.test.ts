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
  it('is always true on the CPU whisper path', () => {
    expect(needsClipCaptionPass({ whisper: 'cpu' }, false)).toBe(true)
    expect(needsClipCaptionPass({ whisper: 'cpu' }, true)).toBe(true)
  })
  it('is never needed on NVIDIA (the large model already ran on the whole VOD)', () => {
    expect(needsClipCaptionPass({ whisper: 'cuda' }, false)).toBe(false)
    expect(needsClipCaptionPass({ whisper: 'cuda' }, true)).toBe(false)
  })
  it('is only needed on Vulkan when some of the VOD did not run on the GPU', () => {
    expect(needsClipCaptionPass({ whisper: 'vulkan' }, true)).toBe(false)
    expect(needsClipCaptionPass({ whisper: 'vulkan' }, false)).toBe(true)
  })
})
