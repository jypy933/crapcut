// Auto-update from GitHub Releases. Checks quietly in the background; when an
// update is downloaded the UI offers "Restart to update".

import { app } from 'electron'
import electronUpdater from 'electron-updater'
import type { UpdateState } from '@shared/types'
import { logger } from './util/log'

const log = logger('update')
const { autoUpdater } = electronUpdater

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

export class Updater {
  private state: UpdateState = { kind: 'idle' }
  private timer: NodeJS.Timeout | null = null

  constructor(private readonly onState: (s: UpdateState) => void) {}

  get current(): UpdateState {
    return this.state
  }

  private set(s: UpdateState): void {
    this.state = s
    this.onState(s)
  }

  start(): void {
    if (!app.isPackaged) return
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.allowPrerelease = false
    autoUpdater.logger = { info: (m: unknown) => log.info(m), warn: (m: unknown) => log.warn(m), error: (m: unknown) => log.error(m), debug: () => {} }
    autoUpdater.on('checking-for-update', () => this.set({ kind: 'checking' }))
    autoUpdater.on('update-available', (i) => this.set({ kind: 'available', version: i.version }))
    autoUpdater.on('update-not-available', () => this.set({ kind: 'none' }))
    autoUpdater.on('download-progress', (p) => this.set({ kind: 'downloading', progress: p.percent / 100 }))
    autoUpdater.on('update-downloaded', (i) => this.set({ kind: 'ready', version: i.version }))
    autoUpdater.on('error', (err) => {
      log.warn('update check failed', err)
      this.set({ kind: 'error' })
    })
    setTimeout(() => void this.check(), 15_000)
    this.timer = setInterval(() => void this.check(), CHECK_EVERY_MS)
  }

  async check(): Promise<void> {
    if (!app.isPackaged) {
      this.set({ kind: 'none' })
      return
    }
    try {
      await autoUpdater.checkForUpdates()
    } catch (err) {
      log.warn('update check failed', err)
      this.set({ kind: 'error' })
    }
  }

  install(): void {
    if (this.state.kind === 'ready') autoUpdater.quitAndInstall(false, true)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
  }
}
