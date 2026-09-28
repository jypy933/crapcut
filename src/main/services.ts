// Builds and wires the long-lived services of the main process.

import { app, Notification, type BrowserWindow } from 'electron'
import type { AppInfo, HardwareProfile, LicenceNotice } from '@shared/types'
import { AutostartManager } from './autostart'
import { ChannelWatchService } from './channelWatch'
import { sendEvent } from './ipc'
import { resolvePaths, type AppPaths } from './paths'
import { Exporter } from './pipeline/exporter'
import { GpuLock } from './pipeline/gpuLock'
import { JobRunner } from './pipeline/runner'
import { stemsAvailable } from './pipeline/stems'
import { Store } from './store'
import { detectHardware } from './tools/gpu'
import { ARTIFACTS, BUNDLED_NOTICES } from './tools/manifest'
import { ToolRegistry } from './tools/registry'
import { SetupManager } from './tools/setup'
import { Updater } from './updater'
import { logger } from './util/log'

const log = logger('app')

export const PROJECT_URL = 'https://github.com/jypy933/crapcut'

export interface AppServices {
  paths: AppPaths
  store: Store
  hardware: HardwareProfile
  tools: ToolRegistry
  setup: SetupManager
  runner: JobRunner
  exporter: Exporter
  updater: Updater
  channelWatch: ChannelWatchService
  autostart: AutostartManager
  allowedLinks: ReadonlySet<string>
  appInfo: () => AppInfo
  onSetupFinished: () => void
}

export function licenceNotices(): LicenceNotice[] {
  const tools = ARTIFACTS.map((a) => ({ name: a.label, version: a.version, licence: a.licence.name, url: a.licence.url, note: a.licence.note ?? null }))
  const bundled = BUNDLED_NOTICES.map((b) => ({ ...b }))
  return [...tools, ...bundled]
}

export async function createServices(resources: string, getWindow: () => BrowserWindow | null): Promise<AppServices> {
  const paths = resolvePaths({ resources, videos: app.getPath('videos') })
  const store = new Store(paths.db)
  const hardware = await detectHardware()
  store.set('hardware', hardware)
  const tools = new ToolRegistry(paths.tools, paths.downloads, (url, init) => fetch(url, init))
  const setup = new SetupManager(tools, hardware, paths.root)
  const gpu = new GpuLock()

  const runner = new JobRunner(store, paths, tools, () => hardware, gpu, {
    onJobChanged: (job) => sendEvent(getWindow(), 'jobs:changed', job),
    onJobReady: (job) => {
      const win = getWindow()
      if (Notification.isSupported() && (!win || !win.isFocused())) {
        const notice = new Notification({ title: 'Clips are ready', body: `${job.clipCount} clips from "${job.vod?.title ?? 'your VOD'}" are ready to review.`, silent: false })
        notice.on('click', () => {
          const w = getWindow()
          if (w) {
            if (w.isMinimized()) w.restore()
            w.show()
            w.focus()
          }
          sendEvent(getWindow(), 'jobs:focus', { jobId: job.id })
        })
        notice.show()
      }
    }
  })
  const exporter = new Exporter(store, paths, tools, () => hardware, gpu, {
    onChanged: (item) => sendEvent(getWindow(), 'exports:changed', item)
  })
  const updater = new Updater((s) => sendEvent(getWindow(), 'app:update', s))
  setup.onChange((s) => sendEvent(getWindow(), 'setup:status', s))
  const channelWatch = new ChannelWatchService({ store, tools, isReady: () => setup.isReady(), enqueueJob: (jobId) => runner.enqueue(jobId) })
  channelWatch.onChange((s) => sendEvent(getWindow(), 'channelWatch:changed', s))
  // Autostart's default follows the channel watch until the user picks explicitly.
  const autostart = new AutostartManager(store, () => channelWatch.status().channel !== null)
  channelWatch.onChange(() => autostart.sync())
  autostart.sync()

  const notices = licenceNotices()
  const allowedLinks = new Set([PROJECT_URL, `${PROJECT_URL}/releases`, ...notices.map((n) => n.url)].map((u) => new URL(u).toString()))

  // Work that was cut short by a crash or close waits for the user to continue.
  const interrupted = store.markInterruptedJobs()
  if (interrupted.length) log.info(`${interrupted.length} job(s) paused after restart`)
  store.requeueInterruptedExports()
  if (setup.isReady()) exporter.resumeQueued()

  return {
    paths,
    store,
    hardware,
    tools,
    setup,
    runner,
    exporter,
    updater,
    channelWatch,
    autostart,
    allowedLinks,
    appInfo: () => ({
      version: app.getVersion(),
      outputDir: paths.output,
      features: { voiceSeparation: stemsAvailable(tools) },
      licences: notices,
      update: updater.current
    }),
    onSetupFinished: () => {
      if (setup.isReady()) exporter.resumeQueued()
    }
  }
}
