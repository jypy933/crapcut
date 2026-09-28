import { describe, expect, it, vi } from 'vitest'
import type { HardwareProfile } from '@shared/types'
import { UserError } from '../util/errors'
import type { Artifact } from './manifest'
import type { InstallProgress, ToolRegistry } from './registry'
import { SetupManager } from './setup'

const nvidia: HardwareProfile = {
  gpus: [{ vendor: 'nvidia', name: 'RTX 3080', vramMb: 10240 }],
  primary: { vendor: 'nvidia', name: 'RTX 3080', vramMb: 10240 },
  whisper: 'cuda',
  llm: 'vulkan',
  totalRamMb: 16384,
  cpuThreads: 16
}

function fakeRegistry(opts: { installed?: string[]; fail?: Record<string, Error> } = {}) {
  const installed = new Set(opts.installed ?? [])
  const order: string[] = []
  const registry = {
    isInstalled: (a: Artifact) => installed.has(a.id),
    partialBytes: () => 0,
    install: vi.fn(async (a: Artifact, _signal: AbortSignal | undefined, onProgress: (p: InstallProgress) => void) => {
      order.push(a.id)
      if (opts.fail?.[a.id]) throw opts.fail[a.id]
      onProgress({ phase: 'downloading', bytes: a.size / 2 })
      onProgress({ phase: 'verifying', bytes: a.size })
      installed.add(a.id)
    })
  }
  return { registry: registry as unknown as ToolRegistry, order, installed }
}

vi.mock('node:fs/promises', async (orig) => {
  const real = await orig<typeof import('node:fs/promises')>()
  return { ...real, statfs: vi.fn(async () => ({ bavail: 1e12, bsize: 1 })) }
})

describe('SetupManager', () => {
  it('lists what this PC needs, with the NVIDIA builds', async () => {
    const { registry } = fakeRegistry()
    const s = await new SetupManager(registry, nvidia, 'C:\\x').status()
    const ids = s.components.map((c) => c.id)
    expect(ids).toContain('whisper-cuda')
    expect(ids).toContain('model-whisper-large')
    expect(ids).toContain('model-llm-8b')
    expect(ids).not.toContain('model-llm-3b')
    expect(s.ready).toBe(false)
    expect(s.remainingBytes).toBeGreaterThan(6e9)
  })

  it('installs small tools first and big optional models last', async () => {
    const { registry, order } = fakeRegistry()
    const m = new SetupManager(registry, nvidia, 'C:\\x')
    await m.start()
    expect(m.isReady()).toBe(true)
    expect(order[0]).toBe('model-vad')
    expect(order[order.length - 1]).toBe('model-llm-8b')
    expect(order.indexOf('ffmpeg')).toBeLessThan(order.indexOf('model-whisper-large'))
  })

  it('is ready even if an optional part fails', async () => {
    const { registry } = fakeRegistry({ fail: { 'model-llm-8b': new UserError('Could not reach the download server.') } })
    const m = new SetupManager(registry, nvidia, 'C:\\x')
    await m.start()
    const s = await m.status()
    expect(s.ready).toBe(true)
    expect(s.error).toBeNull()
    expect(s.components.find((c) => c.id === 'model-llm-8b')?.state).toBe('failed')
  })

  it('stops with one sentence if a required part fails', async () => {
    const { registry } = fakeRegistry({ fail: { ffmpeg: new UserError('A downloaded file was damaged or changed, so it was deleted. Try again.') } })
    const m = new SetupManager(registry, nvidia, 'C:\\x')
    await m.start()
    const s = await m.status()
    expect(s.ready).toBe(false)
    expect(s.error).toBe('A downloaded file was damaged or changed, so it was deleted. Try again.')
  })

  it('refuses to start without enough disk space', async () => {
    const fs = await import('node:fs/promises')
    vi.mocked(fs.statfs).mockResolvedValueOnce({ bavail: 1e9, bsize: 1 } as never)
    const { registry, order } = fakeRegistry()
    const m = new SetupManager(registry, nvidia, 'C:\\x')
    await m.start()
    const s = await m.status()
    expect(order).toEqual([])
    expect(s.error).toMatch(/^Not enough free disk space/)
  })

  it('is ready at once when everything is installed', async () => {
    const { registry } = fakeRegistry()
    const all = new SetupManager(registry, nvidia, 'C:\\x').artifacts().map((a) => a.id)
    const { registry: full } = fakeRegistry({ installed: all })
    expect(new SetupManager(full, nvidia, 'C:\\x').isReady()).toBe(true)
  })
})
