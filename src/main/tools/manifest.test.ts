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

const rtx: HardwareProfile = {
  gpus: [{ vendor: 'nvidia', name: 'RTX 3080', vramMb: 10240 }],
  primary: { vendor: 'nvidia', name: 'RTX 3080', vramMb: 10240 },
  whisper: 'cuda',
  llm: 'vulkan',
  llmCuda: true,
  totalRamMb: 16384,
  cpuThreads: 16
}

describe('CUDA language-model build', () => {
  it('comes from the same pinned release as the Vulkan build, over an allowed host', () => {
    const vulkan = artifact('llama')
    for (const id of ['llama-cuda', 'llama-cuda-runtime'] as const) {
      const a = artifact(id)
      expect(a.url).toContain('/ggml-org/llama.cpp/releases/download/b11236/')
      expect(isAllowedDownloadUrl(a.url)).toBe(true)
      expect(a.sha256).toMatch(/^[0-9a-f]{64}$/)
      expect(a.optional).toBe(true)
    }
    expect(artifact('llama-cuda').version).toBe(vulkan.version)
  })

  it('is fetched only where the PC is set up for it', () => {
    const ids = (hw: HardwareProfile): string[] => neededArtifacts(hw).map((a) => a.id)
    expect(ids(rtx)).toEqual(expect.arrayContaining(['llama', 'llama-cuda', 'llama-cuda-runtime']))
    expect(ids({ ...rtx, llmCuda: false })).not.toContain('llama-cuda')
    expect(ids({ ...rtx, llmCuda: undefined })).not.toContain('llama-cuda-runtime')
  })

  it('unpacks the server and its libraries, and the runtime libraries, but not the other tools', () => {
    const build = artifact('llama-cuda').include!
    for (const name of ['llama-server.exe', 'ggml-cuda.dll', 'ggml-base.dll', 'ggml-cpu-zen4.dll', 'llama.dll', 'LICENSE-LLVM-OpenMP']) expect(build.test(name), name).toBe(true)
    for (const name of ['llama-cli.exe', 'llama-bench.exe', 'ggml-rpc-server.exe']) expect(build.test(name), name).toBe(false)
    const runtime = artifact('llama-cuda-runtime').include!
    for (const name of ['cudart64_12.dll', 'cublas64_12.dll', 'cublasLt64_12.dll']) expect(runtime.test(name), name).toBe(true)
    expect(runtime.test('llama-server.exe')).toBe(false)
    expect(artifact('llama-cuda-runtime').entry).toBe('cudart64_12.dll')
  })

  it('is listed with its licence like every other part', () => {
    expect(artifact('llama-cuda-runtime').licence.name).toContain('CUDA')
    expect(ARTIFACTS.filter((a) => !a.deprecated).map((a) => a.id)).toEqual(expect.arrayContaining(['llama-cuda', 'llama-cuda-runtime']))
  })
})
