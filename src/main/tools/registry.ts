// Installs pinned artifacts and tells the rest of the app where they are.
// Layout: tools/<id>/<version>/... with a marker file written last, so a
// half-finished install is never mistaken for a good one.

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { UserError } from '../util/errors'
import { logger } from '../util/log'
import { downloadVerified, type FetchLike } from './download'
import { extractZip } from './extract'
import { artifact, type Artifact, type ToolId } from './manifest'

const log = logger('tools')
const MARKER = '.crapcut-installed.json'

export interface InstallProgress {
  phase: 'downloading' | 'verifying' | 'installing'
  bytes: number
}

export class ToolRegistry {
  constructor(
    private readonly toolsDir: string,
    private readonly downloadsDir: string,
    private readonly fetchImpl?: FetchLike
  ) {}

  installDir(a: Artifact): string {
    return join(this.toolsDir, a.id, a.version)
  }

  isInstalled(a: Artifact): boolean {
    const marker = join(this.installDir(a), MARKER)
    if (!existsSync(marker)) return false
    try {
      const m = JSON.parse(readFileSync(marker, 'utf8')) as { sha256?: string }
      return m.sha256 === a.sha256 && existsSync(join(this.installDir(a), a.entry))
    } catch {
      return false
    }
  }

  /** Absolute path of a tool's main file, or null when it is not installed. */
  path(id: ToolId): string | null {
    const a = artifact(id)
    return this.isInstalled(a) ? join(this.installDir(a), a.entry) : null
  }

  /** Like path(), but throws a plain-sentence error when missing. */
  require(id: ToolId): string {
    const p = this.path(id)
    if (!p) throw new UserError(`${artifact(id).label} is missing. Open setup to download it again.`, { retryable: false })
    return p
  }

  async install(a: Artifact, signal: AbortSignal | undefined, onProgress: (p: InstallProgress) => void): Promise<void> {
    if (this.isInstalled(a)) return
    mkdirSync(this.downloadsDir, { recursive: true })
    const ext = a.kind === 'zip' ? '.zip' : '.bin'
    const download = join(this.downloadsDir, `${a.id}-${a.version}${ext}`)
    if (!existsSync(download)) {
      await downloadVerified({
        url: a.url,
        dest: download,
        sha256: a.sha256,
        size: a.size,
        signal,
        fetch: this.fetchImpl,
        onProgress: (bytes) => onProgress({ phase: 'downloading', bytes }),
        onVerifying: () => onProgress({ phase: 'verifying', bytes: a.size })
      })
    }
    onProgress({ phase: 'installing', bytes: a.size })

    const final = this.installDir(a)
    const staging = `${final}.tmp`
    rmSync(staging, { recursive: true, force: true })
    mkdirSync(staging, { recursive: true })
    try {
      if (a.kind === 'zip') {
        await extractZip(download, staging, { include: a.include, signal })
        rmSync(download, { force: true })
      } else {
        const target = join(staging, a.entry)
        mkdirSync(dirname(target), { recursive: true })
        renameSync(download, target)
      }
      if (!existsSync(join(staging, a.entry))) throw new Error(`${a.id}: ${a.entry} missing after install`)
      writeFileSync(join(staging, MARKER), JSON.stringify({ id: a.id, version: a.version, sha256: a.sha256, installedAt: new Date().toISOString() }))
      rmSync(final, { recursive: true, force: true })
      mkdirSync(dirname(final), { recursive: true })
      renameSync(staging, final)
    } catch (err) {
      rmSync(staging, { recursive: true, force: true })
      throw err instanceof UserError ? err : new UserError(`Could not install ${a.label}.`, { cause: err })
    }
    this.removeOldVersions(a)
    log.info(`installed ${a.id} ${a.version}`)
  }

  /** Deletes versions of this tool other than the pinned one. */
  private removeOldVersions(a: Artifact): void {
    const dir = join(this.toolsDir, a.id)
    try {
      for (const v of readdirSync(dir)) if (v !== a.version) rmSync(join(dir, v), { recursive: true, force: true })
    } catch {
      // nothing to clean
    }
  }

  /** Deletes an installed (or partially downloaded) artifact to free space. */
  remove(a: Artifact): void {
    rmSync(this.installDir(a), { recursive: true, force: true })
    const ext = a.kind === 'zip' ? '.zip' : '.bin'
    const file = join(this.downloadsDir, `${a.id}-${a.version}${ext}`)
    rmSync(file, { force: true })
    rmSync(`${file}.part`, { force: true })
  }

  /** Bytes already downloaded for an artifact (a resumable part file). */
  partialBytes(a: Artifact): number {
    const ext = a.kind === 'zip' ? '.zip' : '.bin'
    const file = join(this.downloadsDir, `${a.id}-${a.version}${ext}`)
    try {
      if (existsSync(file)) return a.size
      const part = `${file}.part`
      return existsSync(part) ? Math.min(a.size, statSync(part).size) : 0
    } catch {
      return 0
    }
  }
}
