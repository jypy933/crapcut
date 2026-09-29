// Which llama.cpp build runs the language model, and what happens when it does
// not work. NVIDIA PCs try the CUDA build first (prompt reading is about twice
// as fast as on Vulkan) and fall back to the Vulkan build, so a missing driver,
// missing DLL or crashing CUDA setup never costs the smart picks. Pure: the
// process handling is injected, so the sequence is unit-tested with fakes.

import { dirname } from 'node:path'
import type { HardwareProfile } from '@shared/types'
import { isCancelled } from '../util/errors'

export type LlmBackendId = 'cuda' | 'vulkan' | 'cpu'

/** Context tokens each parallel request gets; the whole context is this times the number of slots. */
export const LLM_SLOT_CTX = 4096

export interface LlmAttempt {
  backend: LlmBackendId
  exe: string
  /** Offload every layer to the GPU. */
  gpu: boolean
  /** Only use this device, so a machine where the backend cannot start fails instead of quietly running on the CPU. */
  device: string | null
  /** Folders put in front of PATH for this process only, for DLLs the exe needs. */
  dllDirs: string[]
  slots: number
}

export interface LlmInstall {
  /** The Vulkan build (also the CPU build's binary). */
  llama: string | null
  llamaCuda: string | null
  /** Any file in the CUDA runtime folder (the DLLs sit next to it). */
  cudaRuntime: string | null
}

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

/**
 * The builds to try, in order. CUDA first when this PC is set up for it and
 * both of its parts are installed; the Vulkan (or CPU) build after it.
 */
export function planLlmAttempts(hw: Pick<HardwareProfile, 'llm' | 'llmCuda'>, install: LlmInstall, bigModel: boolean): LlmAttempt[] {
  const out: LlmAttempt[] = []
  if (hw.llmCuda && install.llamaCuda && install.cudaRuntime) {
    out.push({ backend: 'cuda', exe: install.llamaCuda, gpu: true, device: 'CUDA0', dllDirs: [dirname(install.cudaRuntime)], slots: llmSlots(true, bigModel) })
  }
  if (install.llama) {
    const gpu = hw.llm === 'vulkan'
    out.push({ backend: gpu ? 'vulkan' : 'cpu', exe: install.llama, gpu, device: null, dllDirs: [], slots: llmSlots(gpu, bigModel) })
  }
  return out
}

export interface StoppableServer {
  stop(): void
}

export interface StartedLlm<S> {
  server: S
  attempt: LlmAttempt
}

/**
 * Starts the first attempt that works. `start` brings a server up; `verify`
 * sends it its first request. An attempt that fails either one is stopped and
 * the next is tried; a cancel stops the server and is passed on. Returns null
 * when every attempt failed. `start` must clean up after itself when it throws.
 */
export async function startFirstWorking<S extends StoppableServer>(
  attempts: readonly LlmAttempt[],
  deps: {
    start: (attempt: LlmAttempt) => Promise<S>
    /** Runs against a freshly started server; throws when it does not answer. */
    verify: (server: S, attempt: LlmAttempt) => Promise<void>
    /** Reports an attempt that did not work; the next one is tried. */
    onFailed: (attempt: LlmAttempt, error: unknown) => void
  }
): Promise<StartedLlm<S> | null> {
  for (const attempt of attempts) {
    let server: S | null = null
    try {
      server = await deps.start(attempt)
      await deps.verify(server, attempt)
      return { server, attempt }
    } catch (err) {
      server?.stop()
      if (isCancelled(err)) throw err
      deps.onFailed(attempt, err)
    }
  }
  return null
}

/**
 * A copy of `env` with `dirs` in front of PATH. Windows keeps the variable
 * under whatever spelling it was inherited with ("Path"), and a second
 * spelling would give the child two of them, so the existing one is reused.
 */
export function withPathDirs(env: NodeJS.ProcessEnv, dirs: readonly string[], sep = ';'): NodeJS.ProcessEnv {
  if (dirs.length === 0) return env
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH') ?? 'PATH'
  const current = env[key]
  return { ...env, [key]: [...dirs, ...(current ? [current] : [])].join(sep) }
}
