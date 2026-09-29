import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CancelledError } from '../util/errors'
import { LLM_GPU_SLOTS, llmSlots, planLlmAttempts, startFirstWorking, withPathDirs, type LlmAttempt, type LlmInstall } from './llmBackend'

const all: LlmInstall = {
  llama: join('tools', 'llama', 'b1', 'llama-server.exe'),
  llamaCuda: join('tools', 'llama-cuda', 'b1', 'llama-server.exe'),
  cudaRuntime: join('tools', 'llama-cuda-runtime', '12.4', 'cudart64_12.dll')
}

describe('planLlmAttempts', () => {
  it('tries CUDA first on an NVIDIA PC that has both parts, then Vulkan', () => {
    const plan = planLlmAttempts({ llm: 'vulkan', llmCuda: true }, all, true)
    expect(plan.map((a) => a.backend)).toEqual(['cuda', 'vulkan'])
    expect(plan[0]).toMatchObject({ exe: all.llamaCuda, gpu: true, device: 'CUDA0', dllDirs: [join('tools', 'llama-cuda-runtime', '12.4')] })
    expect(plan[1]).toMatchObject({ exe: all.llama, gpu: true, device: null, dllDirs: [] })
  })

  it('leaves an AMD PC on Vulkan as before', () => {
    const plan = planLlmAttempts({ llm: 'vulkan', llmCuda: false }, { ...all, llamaCuda: null, cudaRuntime: null }, true)
    expect(plan.map((a) => a.backend)).toEqual(['vulkan'])
    expect(planLlmAttempts({ llm: 'vulkan' }, all, true).map((a) => a.backend)).toEqual(['vulkan'])
  })

  it('skips CUDA while either of its parts is missing', () => {
    expect(planLlmAttempts({ llm: 'vulkan', llmCuda: true }, { ...all, cudaRuntime: null }, true).map((a) => a.backend)).toEqual(['vulkan'])
    expect(planLlmAttempts({ llm: 'vulkan', llmCuda: true }, { ...all, llamaCuda: null }, true).map((a) => a.backend)).toEqual(['vulkan'])
  })

  it('uses the CPU build without a usable GPU', () => {
    const plan = planLlmAttempts({ llm: 'cpu', llmCuda: false }, all, true)
    expect(plan).toHaveLength(1)
    expect(plan[0]).toMatchObject({ backend: 'cpu', gpu: false, slots: 1 })
  })

  it('has nothing to try when nothing is installed', () => {
    expect(planLlmAttempts({ llm: 'vulkan', llmCuda: true }, { llama: null, llamaCuda: null, cudaRuntime: null }, true)).toEqual([])
  })

  it('runs parallel requests only for the bigger model on a GPU', () => {
    expect(llmSlots(true, true)).toBe(LLM_GPU_SLOTS)
    expect(llmSlots(true, false)).toBe(1)
    expect(llmSlots(false, true)).toBe(1)
  })
})

describe('startFirstWorking', () => {
  const cuda: LlmAttempt = { backend: 'cuda', exe: 'c', gpu: true, device: 'CUDA0', dllDirs: [], slots: 2 }
  const vulkan: LlmAttempt = { backend: 'vulkan', exe: 'v', gpu: true, device: null, dllDirs: [], slots: 2 }

  function fake(opts: { failStart?: string[]; failVerify?: string[]; cancelStart?: string[] } = {}) {
    const events: string[] = []
    const deps = {
      start: async (a: LlmAttempt) => {
        events.push(`start ${a.backend}`)
        if (opts.cancelStart?.includes(a.backend)) throw new CancelledError()
        if (opts.failStart?.includes(a.backend)) throw new Error(`${a.backend} will not start`)
        return { backend: a.backend, stop: () => events.push(`stop ${a.backend}`) }
      },
      verify: async (s: { backend: string }) => {
        events.push(`verify ${s.backend}`)
        if (opts.failVerify?.includes(s.backend)) throw new Error(`${s.backend} does not answer`)
      },
      onFailed: (a: LlmAttempt) => events.push(`failed ${a.backend}`)
    }
    return { events, deps }
  }

  it('keeps the first build when it starts and answers', async () => {
    const { events, deps } = fake()
    const r = await startFirstWorking([cuda, vulkan], deps)
    expect(r?.attempt.backend).toBe('cuda')
    expect(events).toEqual(['start cuda', 'verify cuda'])
  })

  it('falls back to Vulkan when CUDA does not start', async () => {
    const { events, deps } = fake({ failStart: ['cuda'] })
    const r = await startFirstWorking([cuda, vulkan], deps)
    expect(r?.attempt.backend).toBe('vulkan')
    expect(events).toEqual(['start cuda', 'failed cuda', 'start vulkan', 'verify vulkan'])
  })

  it('stops a CUDA server whose first request fails, then starts Vulkan', async () => {
    const { events, deps } = fake({ failVerify: ['cuda'] })
    const r = await startFirstWorking([cuda, vulkan], deps)
    expect(r?.attempt.backend).toBe('vulkan')
    expect(events).toEqual(['start cuda', 'verify cuda', 'stop cuda', 'failed cuda', 'start vulkan', 'verify vulkan'])
  })

  it('gives up cleanly when every build fails', async () => {
    const { events, deps } = fake({ failStart: ['cuda'], failVerify: ['vulkan'] })
    expect(await startFirstWorking([cuda, vulkan], deps)).toBeNull()
    expect(events).toEqual(['start cuda', 'failed cuda', 'start vulkan', 'verify vulkan', 'stop vulkan', 'failed vulkan'])
  })

  it('does not try the next build after a cancel, and stops what it started', async () => {
    const { events, deps } = fake({ cancelStart: ['cuda'] })
    await expect(startFirstWorking([cuda, vulkan], deps)).rejects.toBeInstanceOf(CancelledError)
    expect(events).toEqual(['start cuda'])
    const second = fake()
    second.deps.verify = async () => {
      throw new CancelledError()
    }
    await expect(startFirstWorking([cuda, vulkan], second.deps)).rejects.toBeInstanceOf(CancelledError)
    expect(second.events).toEqual(['start cuda', 'stop cuda'])
  })

  it('returns null for no attempts', async () => {
    expect(await startFirstWorking([], fake().deps)).toBeNull()
  })
})

describe('withPathDirs', () => {
  it('puts the folders in front of the existing PATH, whatever its spelling', () => {
    const env = withPathDirs({ Path: 'C:\\Windows', Other: 'x' }, ['D:\\rt'])
    expect(env).toEqual({ Path: 'D:\\rt;C:\\Windows', Other: 'x' })
    expect(Object.keys(env).filter((k) => k.toUpperCase() === 'PATH')).toHaveLength(1)
  })

  it('creates PATH when there is none, and leaves the environment alone with no folders', () => {
    expect(withPathDirs({}, ['D:\\rt'])).toEqual({ PATH: 'D:\\rt' })
    const env = { PATH: 'a' }
    expect(withPathDirs(env, [])).toBe(env)
  })
})
