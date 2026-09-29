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
  const removed: string[] = []
  const registry = {
    isInstalled: (a: Artifact) => installed.has(a.id),
    partialBytes: () => 0,
    install: vi.fn(async (a: Artifact, _signal: AbortSignal | undefined, onProgress: (p: InstallProgress) => void) => {
      order.push(a.id)
      if (opts.fail?.[a.id]) throw opts.fail[a.id]
      onProgress({ phase: 'downloading', bytes: a.size / 2 })
      onProgress({ phase: 'verifying', bytes: a.size })
      installed.add(a.id)
    }),
    remove: vi.fn((a: Artifact) => {
      removed.push(a.id)
      installed.delete(a.id)
    })
  }
  return { registry: registry as unknown as ToolRegistry, order, installed, removed }
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

  it('start(only) downloads just the requested artifacts, leaving the rest alone', async () => {
    const { registry, order } = fakeRegistry()
    const m = new SetupManager(registry, nvidia, 'C:\\x')
    await m.start(['llama', 'model-llm-8b'])
    expect(order).toEqual(['llama', 'model-llm-8b'])
    const s = await m.status()
    expect(s.components.find((c) => c.id === 'llama')?.state).toBe('ready')
    expect(s.components.find((c) => c.id === 'ffmpeg')?.state).toBe('missing')
    // The required tools are still missing, so the app is not "ready" from this alone.
    expect(s.ready).toBe(false)
  })

  it('start(only) skips artifacts already installed', async () => {
    const { registry, order } = fakeRegistry({ installed: ['llama'] })
    const m = new SetupManager(registry, nvidia, 'C:\\x')
    await m.start(['llama', 'model-llm-8b'])
    expect(order).toEqual(['model-llm-8b'])
  })

  it('remove() deletes an installed optional part and marks it missing again', async () => {
    const { registry, removed } = fakeRegistry({ installed: ['llama', 'model-llm-8b'] })
    const m = new SetupManager(registry, nvidia, 'C:\\x')
    m.remove(['llama', 'model-llm-8b'])
    expect(removed).toEqual(['llama', 'model-llm-8b'])
    const s = await m.status()
    expect(s.components.find((c) => c.id === 'model-llm-8b')?.state).toBe('missing')
  })

  it('remove() refuses with one sentence while a job or export is using the part', async () => {
    const { registry, removed } = fakeRegistry({ installed: ['llama', 'model-llm-8b'] })
    const m = new SetupManager(registry, nvidia, 'C:\\x')
    expect(() => m.remove(['llama', 'model-llm-8b'], () => true)).toThrow('Wait until the current job and exports finish.')
    expect(removed).toEqual([])
    const s = await m.status()
    expect(s.components.find((c) => c.id === 'model-llm-8b')?.state).toBe('ready')
  })

  it('remove() proceeds when nothing is using the part', () => {
    const { registry, removed } = fakeRegistry({ installed: ['llama'] })
    const m = new SetupManager(registry, nvidia, 'C:\\x')
    m.remove(['llama'], () => false)
    expect(removed).toEqual(['llama'])
  })

  it('remove() leaves a component matching disk when the deletion itself fails', async () => {
    const registry = {
      isInstalled: vi.fn(() => true), // rmSync threw before the files were actually gone
      partialBytes: () => 0,
      install: vi.fn(),
      remove: vi.fn(() => {
        throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' })
      })
    } as unknown as ToolRegistry
    const m = new SetupManager(registry, nvidia, 'C:\\x')
    expect(() => m.remove(['llama'])).toThrow('Could not remove')
    const s = await m.status()
    // isInstalled() still says yes, so the component stays "ready" rather than a half-deleted "missing".
    expect(s.components.find((c) => c.id === 'llama')?.state).toBe('ready')
  })

  it('remove() does nothing while a download is running', async () => {
    let resolveInstall: () => void = () => {}
    const registry = {
      isInstalled: () => false,
      partialBytes: () => 0,
      install: vi.fn(() => new Promise<void>((resolve) => (resolveInstall = resolve))),
      remove: vi.fn()
    } as unknown as ToolRegistry
    const m = new SetupManager(registry, nvidia, 'C:\\x')
    const running = m.start(['llama'])
    m.remove(['llama'])
    expect((registry as unknown as { remove: ReturnType<typeof vi.fn> }).remove).not.toHaveBeenCalled()
    // Let start()'s pending disk-space check settle so it reaches registry.install
    // and captures the real resolver, then let the (fake) install finish.
    await new Promise((r) => setTimeout(r, 0))
    resolveInstall()
    await running
  })
})
