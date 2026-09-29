import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { LLM_SLOT_CTX, startFirstWorking, type LlmAttempt } from '../core/llmBackend'
import { LlamaServer } from './ai'

const base = { exe: 'llama-server.exe', cwd: '.', model: 'm.gguf', gpu: true }

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name)
  return i >= 0 ? args[i + 1] : undefined
}

describe('LlamaServer arguments', () => {
  it('keeps the one-request setup unchanged', () => {
    const args = new LlamaServer(base).args()
    expect(flag(args, '-c')).toBe(String(LLM_SLOT_CTX))
    expect(flag(args, '-np')).toBe('1')
    expect(flag(args, '-ngl')).toBe('999')
    expect(args).not.toContain('--device')
  })

  it('gives each parallel request its own share of the context', () => {
    const args = new LlamaServer({ ...base, slots: 2 }).args()
    expect(flag(args, '-np')).toBe('2')
    expect(flag(args, '-c')).toBe(String(2 * LLM_SLOT_CTX))
  })

  it('offloads nothing without a GPU and pins a device when asked', () => {
    expect(flag(new LlamaServer({ ...base, gpu: false }).args(), '-ngl')).toBe('0')
    expect(flag(new LlamaServer({ ...base, device: 'CUDA0' }).args(), '--device')).toBe('CUDA0')
  })
})

describe('a build that cannot start', () => {
  it('fails at once when the executable is not there, instead of waiting for it', async () => {
    const server = new LlamaServer({ ...base, exe: join(process.cwd(), 'no-such-dir', 'llama-server.exe') })
    const t0 = Date.now()
    await expect(server.start(new AbortController().signal)).rejects.toThrow()
    expect(Date.now() - t0).toBeLessThan(10_000)
    server.stop()
  })

  it('falls back to the next build when the CUDA one is missing', async () => {
    const cuda: LlmAttempt = { backend: 'cuda', exe: join(process.cwd(), 'no-such-dir', 'llama-server.exe'), gpu: true, device: 'CUDA0', dllDirs: [], slots: 2 }
    const vulkan: LlmAttempt = { backend: 'vulkan', exe: 'v', gpu: true, device: null, dllDirs: [], slots: 2 }
    const failed: string[] = []
    const r = await startFirstWorking([cuda, vulkan], {
      start: async (a) => {
        if (a.backend === 'vulkan') return { stop: () => {} }
        const server = new LlamaServer({ ...base, exe: a.exe, device: a.device })
        try {
          await server.start(new AbortController().signal)
        } catch (err) {
          server.stop()
          throw err
        }
        return server
      },
      verify: async () => {},
      onFailed: (a) => failed.push(a.backend)
    })
    expect(r?.attempt.backend).toBe('vulkan')
    expect(failed).toEqual(['cuda'])
  })
})
