import { describe, expect, it } from 'vitest'
import type { HardwareProfile } from '@shared/types'
import { acceleratorsToFetch } from './accelerators'
import { artifact } from './manifest'

const amd: HardwareProfile = {
  gpus: [{ vendor: 'amd', name: 'RX 9060 XT', vramMb: 8144 }],
  primary: { vendor: 'amd', name: 'RX 9060 XT', vramMb: 8144 },
  whisper: 'vulkan',
  llm: 'vulkan',
  totalRamMb: 32478,
  cpuThreads: 16
}

describe('acceleratorsToFetch', () => {
  it('fetches the Vulkan whisper build on an AMD PC set up before it existed', () => {
    expect(acceleratorsToFetch(amd, () => false)).toEqual(['whisper-vulkan'])
  })

  it('does nothing once it is installed', () => {
    expect(acceleratorsToFetch(amd, (id) => id === 'whisper-vulkan')).toEqual([])
  })

  it('does nothing on a PC that does not need it', () => {
    expect(acceleratorsToFetch({ ...amd, whisper: 'cpu' }, () => false)).toEqual([])
  })

  it('fetches the CUDA language-model build on NVIDIA only when the language model is installed', () => {
    const rtx: HardwareProfile = {
      ...amd,
      gpus: [{ vendor: 'nvidia', name: 'RTX 3080', vramMb: 10240 }],
      primary: { vendor: 'nvidia', name: 'RTX 3080', vramMb: 10240 },
      whisper: 'cuda',
      llmCuda: true
    }
    expect(acceleratorsToFetch(rtx, (id) => id === 'llama')).toEqual(['llama-cuda', 'llama-cuda-runtime'])
    expect(acceleratorsToFetch(rtx, () => false)).toEqual([])
    expect(acceleratorsToFetch({ ...rtx, llmCuda: false }, (id) => id === 'llama')).toEqual([])
  })

  it('never blocks setup: every accelerator is optional', () => {
    for (const id of ['whisper-vulkan', 'llama-cuda', 'llama-cuda-runtime'] as const) expect(artifact(id).optional).toBe(true)
  })
})
