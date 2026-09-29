import { describe, expect, it } from 'vitest'
import { LLM_GPU_SLOTS, llmSlots } from './llmBackend'

describe('llmSlots', () => {
  it('runs parallel requests only for the bigger model on a GPU', () => {
    expect(llmSlots(true, true)).toBe(LLM_GPU_SLOTS)
    expect(llmSlots(true, false)).toBe(1)
    expect(llmSlots(false, true)).toBe(1)
    expect(llmSlots(false, false)).toBe(1)
  })
})
