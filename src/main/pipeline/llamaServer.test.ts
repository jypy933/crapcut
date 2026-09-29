import { describe, expect, it } from 'vitest'
import { LLM_SLOT_CTX } from '../core/llmBackend'
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
  })

  it('gives each parallel request its own share of the context', () => {
    const args = new LlamaServer({ ...base, slots: 3 }).args()
    expect(flag(args, '-np')).toBe('3')
    expect(flag(args, '-c')).toBe(String(3 * LLM_SLOT_CTX))
  })

  it('offloads nothing without a GPU', () => {
    expect(flag(new LlamaServer({ ...base, gpu: false }).args(), '-ngl')).toBe('0')
  })
})
