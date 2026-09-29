import { describe, expect, it } from 'vitest'
import type { HardwareProfile } from '@shared/types'
import { ARTIFACTS, artifact, isAllowedDownloadUrl, neededArtifacts } from './manifest'

const base: HardwareProfile = { gpus: [], primary: null, whisper: 'cpu', llm: 'cpu', totalRamMb: 16384, cpuThreads: 8 }
const ids = (hw: HardwareProfile): string[] => neededArtifacts(hw).map((a) => a.id)

describe('whisper builds per machine', () => {
  it('fetches only the CPU build without a usable GPU', () => {
    expect(ids(base)).toContain('whisper-cpu')
    expect(ids(base)).not.toContain('whisper-cuda')
    expect(ids(base)).not.toContain('whisper-vulkan')
  })

  it('adds the Vulkan build on Vulkan whisper, and never the CUDA one', () => {
    const got = ids({ ...base, whisper: 'vulkan', llm: 'vulkan' })
    expect(got).toContain('whisper-cpu')
    expect(got).toContain('whisper-vulkan')
    expect(got).not.toContain('whisper-cuda')
  })

  it('adds the CUDA build on CUDA whisper, and never the Vulkan one', () => {
    const got = ids({ ...base, whisper: 'cuda', llm: 'vulkan' })
    expect(got).toContain('whisper-cuda')
    expect(got).not.toContain('whisper-vulkan')
  })
})

describe('whisper-vulkan artifact', () => {
  const a = artifact('whisper-vulkan')

  it("is a pinned asset of this repo's tools prerelease, with a real checksum", () => {
    expect(isAllowedDownloadUrl(a.url)).toBe(true)
    expect(a.url).toMatch(/^https:\/\/github\.com\/jypy933\/crapcut\/releases\/download\/tools-[\w.-]+\/whisper-vulkan-bin-x64\.zip$/)
    expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(a.size).toBeGreaterThan(1_000_000)
  })

  it('extracts the executable and its libraries from the Release folder, like the CPU build', () => {
    expect(a.entry).toBe(artifact('whisper-cpu').entry)
    const inc = a.include!
    for (const f of ['whisper-cli.exe', 'whisper.dll', 'ggml.dll', 'ggml-base.dll', 'ggml-vulkan.dll', 'ggml-cpu-haswell.dll', 'LICENSE']) {
      expect(inc.test(`Release/${f}`)).toBe(true)
    }
    expect(inc.test('Release/whisper-bench.exe')).toBe(false)
    expect(inc.test('whisper-cli.exe')).toBe(false)
  })
})

describe('manifest', () => {
  it('has unique ids and a checksum on every artifact', () => {
    expect(new Set(ARTIFACTS.map((x) => x.id)).size).toBe(ARTIFACTS.length)
    for (const x of ARTIFACTS) expect(x.sha256).toMatch(/^[0-9a-f]{64}$/)
  })
})
