// Detects graphics cards and decides where AI work and encoding run.
// Reads the Windows display-adapter registry (no admin needed) and, on NVIDIA,
// asks nvidia-smi for memory and driver details.

import { execFile } from 'node:child_process'
import { cpus, totalmem } from 'node:os'
import { promisify } from 'node:util'
import type { GpuInfo, GpuVendor, HardwareProfile } from '@shared/types'
import { logger } from '../util/log'
import { nvidiaSmiPath, REG_EXE } from './systemTools'

const run = promisify(execFile)
const log = logger('gpu')

const ADAPTER_KEY = 'HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}'

export function vendorFromPci(id: string): GpuVendor {
  const m = /VEN_([0-9A-F]{4})/i.exec(id)
  switch (m?.[1]?.toUpperCase()) {
    case '10DE':
      return 'nvidia'
    case '1002':
    case '1022':
      return 'amd'
    case '8086':
      return 'intel'
    default:
      return 'other'
  }
}

/** Parses `reg query <key> /s /v <name>` into { subkey path: value }. */
export function parseRegValues(output: string, name: string): Map<string, string> {
  const out = new Map<string, string>()
  let key: string | null = null
  for (const raw of output.split(/\r?\n/)) {
    const line = raw.trimEnd()
    if (line.startsWith('HKEY_')) {
      key = line.trim()
      continue
    }
    const m = /^\s+(\S+)\s+(REG_\w+)\s+(.*)$/.exec(line)
    if (m && key && m[1]!.toLowerCase() === name.toLowerCase()) out.set(key, m[3]!.trim())
  }
  return out
}

function regNumber(value: string | undefined): number | null {
  if (!value) return null
  const v = value.trim()
  const n = v.startsWith('0x') ? Number.parseInt(v, 16) : Number(v)
  return Number.isFinite(n) && n > 0 ? n : null
}

/** Combines the three registry queries into a list of adapters. */
export function adaptersFromRegistry(desc: string, device: string, memory: string, memory32: string): GpuInfo[] {
  const names = parseRegValues(desc, 'DriverDesc')
  const ids = parseRegValues(device, 'MatchingDeviceId')
  const mem = parseRegValues(memory, 'HardwareInformation.qwMemorySize')
  const mem32 = parseRegValues(memory32, 'HardwareInformation.MemorySize')
  const out: GpuInfo[] = []
  for (const [key, name] of names) {
    const id = ids.get(key) ?? ''
    const vendor = vendorFromPci(id)
    // Skip virtual adapters (remote desktop, virtual displays).
    if (!id.toUpperCase().startsWith('PCI\\')) continue
    const bytes = regNumber(mem.get(key)) ?? regNumber(mem32.get(key))
    out.push({ vendor, name, vramMb: bytes ? Math.round(bytes / (1024 * 1024)) : null })
  }
  return out
}

/** Parses `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits`. */
export function parseNvidiaSmi(output: string): { name: string; vramMb: number; driver: string }[] {
  const out: { name: string; vramMb: number; driver: string }[] = []
  for (const line of output.split(/\r?\n/)) {
    const parts = line.split(',').map((p) => p.trim())
    if (parts.length < 3) continue
    const vram = Number(parts[1])
    if (!parts[0] || !Number.isFinite(vram)) continue
    out.push({ name: parts[0], vramMb: vram, driver: parts[2]! })
  }
  return out
}

/** Minimum VRAM to run whisper large-v3-turbo on the GPU (CUDA or Vulkan). */
export const WHISPER_GPU_MIN_VRAM_MB = 3500
/** Minimum NVIDIA driver for the CUDA 11.8 whisper build. */
export const MIN_NVIDIA_DRIVER = 452.39

/**
 * Minimum NVIDIA driver for the CUDA 12.4 llama.cpp build: the driver that
 * ships with the CUDA 12.4 GA toolkit (release notes, "CUDA Toolkit and
 * Corresponding Driver Versions": >=551.61 on Windows). The 528.33 minor-version
 * compatibility floor is not used: only the documented minimum is trusted here.
 */
export const LLAMA_CUDA_MIN_DRIVER = 551.61

export function chooseProfile(gpus: GpuInfo[], nvidiaDriver: number | null, totalRamMb: number, cpuThreads: number): HardwareProfile {
  const rank = (g: GpuInfo): number => (g.vendor === 'nvidia' ? 3 : g.vendor === 'amd' ? 2 : g.vendor === 'intel' ? 1 : 0) * 1e6 + (g.vramMb ?? 0)
  const primary = [...gpus].filter((g) => g.vendor !== 'other').sort((a, b) => rank(b) - rank(a))[0] ?? null
  const cudaOk =
    primary?.vendor === 'nvidia' && (primary.vramMb ?? 0) >= WHISPER_GPU_MIN_VRAM_MB && (nvidiaDriver === null || nvidiaDriver >= MIN_NVIDIA_DRIVER)
  // whisper.cpp's Vulkan build covers AMD cards that have no CUDA. NVIDIA without a
  // usable CUDA path stays on the CPU: that combination is not one we can test.
  const whisperVulkanOk = !cudaOk && primary?.vendor === 'amd' && (primary.vramMb ?? 0) >= WHISPER_GPU_MIN_VRAM_MB
  // Vulkan (llama.cpp) is worth it on dedicated NVIDIA/AMD cards with enough memory.
  const vulkanOk = !!primary && (primary.vendor === 'nvidia' || primary.vendor === 'amd') && (primary.vramMb ?? 0) >= 4000
  return {
    gpus,
    primary,
    whisper: cudaOk ? 'cuda' : whisperVulkanOk ? 'vulkan' : 'cpu',
    llm: vulkanOk ? 'vulkan' : 'cpu',
    // The CUDA build is an optional speed-up on top of Vulkan, so it needs a driver known to be new enough.
    llmCuda: vulkanOk && primary?.vendor === 'nvidia' && nvidiaDriver !== null && nvidiaDriver >= LLAMA_CUDA_MIN_DRIVER,
    totalRamMb,
    cpuThreads
  }
}

async function reg(value: string): Promise<string> {
  try {
    const { stdout } = await run(REG_EXE, ['query', ADAPTER_KEY, '/s', '/v', value], { windowsHide: true, timeout: 15000 })
    return stdout
  } catch (err) {
    // reg exits 1 when nothing matched; its stdout is still useful.
    return (err as { stdout?: string }).stdout ?? ''
  }
}

export async function detectHardware(): Promise<HardwareProfile> {
  const totalRamMb = Math.round(totalmem() / (1024 * 1024))
  const cpuThreads = cpus().length
  if (process.platform !== 'win32') return chooseProfile([], null, totalRamMb, cpuThreads)

  const [desc, device, memory, memory32] = await Promise.all([
    reg('DriverDesc'),
    reg('MatchingDeviceId'),
    reg('HardwareInformation.qwMemorySize'),
    reg('HardwareInformation.MemorySize')
  ])
  let gpus = adaptersFromRegistry(desc, device, memory, memory32)
  let driver: number | null = null

  if (gpus.some((g) => g.vendor === 'nvidia')) {
    const smiExe = nvidiaSmiPath()
    try {
      if (!smiExe) throw new Error('nvidia-smi not found')
      const { stdout } = await run(smiExe, ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], {
        windowsHide: true,
        timeout: 15000
      })
      const smi = parseNvidiaSmi(stdout)
      if (smi[0]) {
        driver = Number.parseFloat(smi[0].driver) || null
        gpus = gpus.map((g) => {
          const match = smi.find((s) => s.name === g.name) ?? (g.vendor === 'nvidia' ? smi[0] : undefined)
          return match ? { ...g, vramMb: match.vramMb } : g
        })
      }
    } catch (err) {
      log.warn('nvidia-smi not available', err)
    }
  }

  const profile = chooseProfile(gpus, driver, totalRamMb, cpuThreads)
  log.info('hardware', { gpus: profile.gpus, whisper: profile.whisper, llm: profile.llm, llmCuda: profile.llmCuda, ramMb: totalRamMb, threads: cpuThreads, driver })
  return profile
}

/** Free VRAM in MB on NVIDIA cards, or null when unknown. */
export async function nvidiaFreeVramMb(): Promise<number | null> {
  const smiExe = nvidiaSmiPath()
  if (!smiExe) return null
  try {
    const { stdout } = await run(smiExe, ['--query-gpu=memory.free', '--format=csv,noheader,nounits'], { windowsHide: true, timeout: 10000 })
    const n = Number(stdout.split(/\r?\n/)[0]?.trim())
    return Number.isFinite(n) ? n : null
  } catch {
    return null
  }
}
