// Absolute paths for the Windows programs CrapCut calls, so a folder earlier
// in PATH can never stand in for them.

import { existsSync } from 'node:fs'
import { join } from 'node:path'

const systemRoot = process.env.SystemRoot ?? process.env.windir ?? 'C:\\Windows'
const system32 = join(systemRoot, 'System32')

export const REG_EXE = join(system32, 'reg.exe')
export const TASKKILL_EXE = join(system32, 'taskkill.exe')

/** nvidia-smi ships in System32 with current drivers, in NVSMI with older ones. */
export function nvidiaSmiPath(): string | null {
  const programFiles = process.env.ProgramFiles ?? 'C:\\Program Files'
  const candidates = [join(system32, 'nvidia-smi.exe'), join(programFiles, 'NVIDIA Corporation', 'NVSMI', 'nvidia-smi.exe')]
  return candidates.find((p) => existsSync(p)) ?? null
}
