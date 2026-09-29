import { describe, expect, it } from 'vitest'
import type { HardwareProfile } from '@shared/types'
import { legacyLlmToRemove, shouldAutoFetchReplacement } from './llmMigration'

const bigGpu: HardwareProfile = {
  gpus: [{ vendor: 'amd', name: 'RX 9060 XT', vramMb: 8144 }],
  primary: { vendor: 'amd', name: 'RX 9060 XT', vramMb: 8144 },
  whisper: 'cpu',
  llm: 'vulkan',
  totalRamMb: 32478,
  cpuThreads: 16
}

const smallGpu: HardwareProfile = { ...bigGpu, primary: { vendor: 'amd', name: 'Small GPU', vramMb: 4000 } }

describe('legacyLlmToRemove', () => {
  it('removes the old model once the new one is installed on a big-tier PC', () => {
    const installed = new Set(['model-llm-8b', 'model-llm-9b'])
    expect(legacyLlmToRemove(bigGpu, (id) => installed.has(id))).toEqual(['model-llm-8b'])
  })

  it('keeps the old model until the new one is fully installed', () => {
    const installed = new Set(['model-llm-8b'])
    expect(legacyLlmToRemove(bigGpu, (id) => installed.has(id))).toEqual([])
  })

  it('does nothing when there is no old install to clean up', () => {
    const installed = new Set(['model-llm-9b'])
    expect(legacyLlmToRemove(bigGpu, (id) => installed.has(id))).toEqual([])
  })

  it('does nothing on a PC that cannot run the big tier at all', () => {
    const installed = new Set(['model-llm-8b', 'model-llm-9b'])
    expect(legacyLlmToRemove(smallGpu, (id) => installed.has(id))).toEqual([])
  })
})

describe('shouldAutoFetchReplacement', () => {
  it('is true once the old model is on disk and the new one is not', () => {
    const installed = new Set(['model-llm-8b'])
    expect(shouldAutoFetchReplacement(bigGpu, (id) => installed.has(id))).toBe(true)
  })

  it('is false once the new model is already installed', () => {
    const installed = new Set(['model-llm-8b', 'model-llm-9b'])
    expect(shouldAutoFetchReplacement(bigGpu, (id) => installed.has(id))).toBe(false)
  })

  it('is false with no old install (a fresh PC just uses the normal setup flow)', () => {
    expect(shouldAutoFetchReplacement(bigGpu, () => false)).toBe(false)
  })

  it('is false on a small-GPU PC', () => {
    const installed = new Set(['model-llm-8b'])
    expect(shouldAutoFetchReplacement(smallGpu, (id) => installed.has(id))).toBe(false)
  })
})
