import { describe, expect, it } from 'vitest'
import type { HardwareProfile, SetupComponent } from './types'
import { buildOptionalModels, optionalModelArtifactIds } from './optionalModels'

const bigGpu: HardwareProfile = {
  gpus: [{ vendor: 'amd', name: 'RX 9060 XT', vramMb: 8144 }],
  primary: { vendor: 'amd', name: 'RX 9060 XT', vramMb: 8144 },
  whisper: 'cpu',
  llm: 'vulkan',
  totalRamMb: 32478,
  cpuThreads: 16
}

const smallGpu: HardwareProfile = { ...bigGpu, primary: { vendor: 'amd', name: 'Small GPU', vramMb: 4000 } }

function components(overrides: Partial<Record<string, Partial<SetupComponent>>> = {}): SetupComponent[] {
  const base: Record<string, SetupComponent> = {
    llama: { id: 'llama', label: 'llama.cpp', sizeBytes: 33064176, state: 'ready', progress: 1, optional: true },
    'model-llm-9b': { id: 'model-llm-9b', label: 'Language model (Qwen3.5 9B)', sizeBytes: 5680522464, state: 'missing', progress: 0, optional: true },
    'model-llm-3b': { id: 'model-llm-3b', label: 'Language model (Ministral 3 3B)', sizeBytes: 2147023008, state: 'missing', progress: 0, optional: true },
    separator: { id: 'separator', label: 'Voice separator (demucs.cpp)', sizeBytes: 2102181, state: 'missing', progress: 0, optional: true },
    'model-demucs': { id: 'model-demucs', label: 'Voice separation model (Demucs htdemucs)', sizeBytes: 83994361, state: 'missing', progress: 0, optional: true }
  }
  for (const [id, patch] of Object.entries(overrides)) {
    const existing = base[id]
    if (existing && patch) base[id] = { ...existing, ...patch }
  }
  return Object.values(base)
}

describe('optionalModelArtifactIds', () => {
  it('picks the 9B model when the GPU has enough VRAM', () => {
    expect(optionalModelArtifactIds('llm', bigGpu)).toEqual(['llama', 'model-llm-9b'])
  })

  it('picks the 3B model otherwise', () => {
    expect(optionalModelArtifactIds('llm', smallGpu)).toEqual(['llama', 'model-llm-3b'])
  })

  it('voice separation is the same on every PC', () => {
    expect(optionalModelArtifactIds('voiceSeparation', smallGpu)).toEqual(['separator', 'model-demucs'])
  })
})

describe('buildOptionalModels', () => {
  it('is "missing" until every artifact in the part is ready', () => {
    const models = buildOptionalModels(bigGpu, components())
    const llm = models.find((m) => m.id === 'llm')!
    expect(llm.state).toBe('missing')
    expect(llm.sizeBytes).toBe(33064176 + 5680522464)
    expect(llm.variant).toBe('Qwen3.5 9B')
  })

  it('is "ready" once both artifacts are installed', () => {
    const models = buildOptionalModels(bigGpu, components({ 'model-llm-9b': { state: 'ready', progress: 1 } }))
    expect(models.find((m) => m.id === 'llm')?.state).toBe('ready')
  })

  it('reports downloading with a combined progress while one artifact is fetching', () => {
    const models = buildOptionalModels(bigGpu, components({ 'model-llm-9b': { state: 'downloading', progress: 0.5 } }))
    const llm = models.find((m) => m.id === 'llm')!
    expect(llm.state).toBe('downloading')
    expect(llm.progress).toBeCloseTo((33064176 * 1 + 5680522464 * 0.5) / (33064176 + 5680522464))
  })

  it('surfaces a failed artifact even if the other one in the part is ready', () => {
    const models = buildOptionalModels(bigGpu, components({ 'model-llm-9b': { state: 'failed', progress: 0.2 } }))
    expect(models.find((m) => m.id === 'llm')?.state).toBe('failed')
  })

  it('has no variant for voice separation', () => {
    const models = buildOptionalModels(bigGpu, components())
    expect(models.find((m) => m.id === 'voiceSeparation')?.variant).toBeNull()
  })
})
