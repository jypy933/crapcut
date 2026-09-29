// How the language model server is set up: how many requests it serves at once.

/** Context tokens each parallel request gets; the whole context is this times the number of slots. */
export const LLM_SLOT_CTX = 4096

/**
 * Parallel requests for the bigger model on a GPU. Measured on an 8 GB card (a
 * 38-request batch): 1 slot 57 s, 2 slots 43 s, 3 slots 37 s, 4 slots 37 s,
 * while the extra VRAM is small (about 100 MB per slot). The 3B tier, the CPU
 * and a leftover Ministral 8B stay at one.
 */
export const LLM_GPU_SLOTS = 3

export function llmSlots(gpu: boolean, bigModel: boolean): number {
  return gpu && bigModel ? LLM_GPU_SLOTS : 1
}
