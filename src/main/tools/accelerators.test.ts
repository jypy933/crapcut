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

  it('never blocks setup: every accelerator is optional', () => {
    expect(artifact('whisper-vulkan').optional).toBe(true)
  })
})
