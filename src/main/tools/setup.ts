// First-run setup: works out which tools and models this PC needs, checks disk
// space, downloads and verifies them one by one, and reports progress.

import { statfs } from 'node:fs/promises'
import type { HardwareProfile, SetupComponent, SetupStatus } from '@shared/types'
import { EtaEstimator } from '../core/eta'
import { isCancelled, userMessage } from '../util/errors'
import { logger } from '../util/log'
import { artifact, neededArtifacts, type Artifact, type ToolId } from './manifest'
import type { ToolRegistry } from './registry'

const log = logger('setup')

/** Room left over after setup for a stream's audio and clips. */
const HEADROOM_BYTES = 3 * 1024 ** 3

export async function freeBytes(dir: string): Promise<number | null> {
  try {
    const s = await statfs(dir)
    return s.bavail * s.bsize
  } catch {
    return null
  }
}

export class SetupManager {
  private components = new Map<string, SetupComponent>()
  private running = false
  private controller: AbortController | null = null
  private error: string | null = null
  private eta = new EtaEstimator()
  private etaSec: number | null = null
  private free: number | null = null
  private listeners = new Set<(s: SetupStatus) => void>()
  private lastEmit = 0

  constructor(
    private readonly registry: ToolRegistry,
    private readonly hardware: HardwareProfile,
    private readonly rootDir: string
  ) {
    for (const a of this.artifacts()) {
      const ready = registry.isInstalled(a)
      this.components.set(a.id, {
        id: a.id,
        label: a.label,
        sizeBytes: a.size,
        state: ready ? 'ready' : 'missing',
        progress: ready ? 1 : registry.partialBytes(a) / a.size,
        optional: a.optional
      })
    }
  }

  artifacts(): Artifact[] {
    return neededArtifacts(this.hardware)
  }

  onChange(fn: (s: SetupStatus) => void): () => void {
    this.listeners.add(fn)
    return () => this.listeners.delete(fn)
  }

  /** One component's state, for a settings screen that only cares about a few ids. */
  component(id: ToolId): SetupComponent | undefined {
    return this.components.get(id)
  }

  /** Ready when every required (non-optional) component is installed. */
  isReady(): boolean {
    return [...this.components.values()].every((c) => c.optional || c.state === 'ready')
  }

  async status(): Promise<SetupStatus> {
    this.free = await freeBytes(this.rootDir)
    return this.snapshot()
  }

  private snapshot(): SetupStatus {
    const components = [...this.components.values()]
    const remaining = components.filter((c) => c.state !== 'ready').reduce((s, c) => s + c.sizeBytes * (1 - c.progress), 0)
    return {
      ready: this.isReady(),
      running: this.running,
      components,
      remainingBytes: Math.round(remaining),
      freeBytes: this.free,
      etaSec: this.running ? this.etaSec : null,
      error: this.error,
      hardware: this.hardware
    }
  }

  private emit(force = false): void {
    const now = Date.now()
    if (!force && now - this.lastEmit < 200) return
    this.lastEmit = now
    const s = this.snapshot()
    for (const fn of this.listeners) fn(s)
  }

  private update(id: string, patch: Partial<SetupComponent>, force = false): void {
    const c = this.components.get(id)
    if (!c) return
    Object.assign(c, patch)
    this.emit(force)
  }

  /** Space needed for what is left (zips need room to extract). Restrict to `only` for a partial download. */
  requiredBytes(only?: readonly ToolId[]): number {
    let need = HEADROOM_BYTES
    for (const a of this.artifacts()) {
      if (only && !only.includes(a.id)) continue
      const c = this.components.get(a.id)
      if (!c || c.state === 'ready') continue
      need += a.size * (a.kind === 'zip' ? 2 : 1) * (1 - c.progress)
    }
    return Math.round(need)
  }

  cancel(): void {
    this.controller?.abort()
  }

  /**
   * Downloads what is missing. With `only`, downloads just those artifacts
   * (e.g. one optional AI part picked from a settings screen) instead of
   * everything the PC still needs.
   */
  async start(only?: readonly ToolId[]): Promise<void> {
    if (this.running) return
    this.running = true
    this.error = null
    this.controller = new AbortController()
    const signal = this.controller.signal
    this.eta.reset()
    this.etaSec = null
    this.emit(true)

    try {
      this.free = await freeBytes(this.rootDir)
      if (this.free !== null && this.free < this.requiredBytes(only)) {
        const needGb = Math.ceil(this.requiredBytes(only) / 1024 ** 3)
        this.error = `Not enough free disk space. CrapCut needs about ${needGb} GB free on this drive.`
        return
      }

      const todo = this.artifacts().filter((a) => (!only || only.includes(a.id)) && this.components.get(a.id)?.state !== 'ready')
      // Small tools first so the app becomes usable quickly; big models last.
      todo.sort((a, b) => Number(a.optional) - Number(b.optional) || a.size - b.size)
      const totalBytes = todo.reduce((s, a) => s + a.size, 0)
      let doneBytes = 0

      for (const a of todo) {
        if (signal.aborted) break
        try {
          await this.registry.install(a, signal, (p) => {
            const state = p.phase === 'downloading' ? 'downloading' : p.phase === 'verifying' ? 'verifying' : 'installing'
            this.etaSec = this.eta.update(doneBytes + p.bytes, totalBytes)
            this.update(a.id, { state, progress: p.bytes / a.size })
          })
          this.update(a.id, { state: 'ready', progress: 1 }, true)
        } catch (err) {
          if (isCancelled(err)) throw err
          log.error(`install failed: ${a.id}`, err)
          this.update(a.id, { state: 'failed' }, true)
          // An optional part failing (the language model) should not block the app.
          if (!a.optional) {
            this.error = userMessage(err, `Could not download ${a.label}. Check your internet connection and try again.`)
            return
          }
        }
        doneBytes += a.size
      }
    } catch (err) {
      if (!isCancelled(err)) {
        log.error('setup failed', err)
        this.error = userMessage(err, 'Setup stopped unexpectedly. Try again.')
      }
      for (const c of this.components.values()) if (c.state !== 'ready' && c.state !== 'failed') c.state = 'missing'
    } finally {
      this.running = false
      this.controller = null
      this.free = await freeBytes(this.rootDir)
      this.emit(true)
    }
  }

  /** Deletes installed (or partially downloaded) artifacts to free space. Ignored while a download is running. */
  remove(ids: readonly ToolId[]): void {
    if (this.running) return
    for (const id of ids) {
      this.registry.remove(artifact(id))
      this.update(id, { state: 'missing', progress: 0 }, true)
    }
  }
}
