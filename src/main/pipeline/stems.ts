// Voice / background separation for the per-clip audio options. Runs only on
// the chosen clip's audio at export, never on the whole stream.

import type { HardwareProfile } from '@shared/types'
import type { ToolRegistry } from '../tools/registry'
import { UserError } from '../util/errors'
import type { GpuLock } from './gpuLock'

export interface StemOptions {
  ffmpeg: string
  tools: ToolRegistry
  hw: HardwareProfile
  gpu: GpuLock
  input: string
  seek: number
  duration: number
  workDir: string
  signal: AbortSignal
  onProgress: (f: number) => void
}

export interface Stems {
  /** Absolute path of the voice-only WAV (clip length). */
  voice: string
  /** Absolute path of everything except the voice (clip length). */
  background: string
}

export function stemsAvailable(_tools: ToolRegistry): boolean {
  return false
}

export async function prepareStems(_opts: StemOptions): Promise<Stems> {
  throw new UserError('Voice separation is not available yet. Use Original audio for now.', { retryable: false })
}
