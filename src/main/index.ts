// CrapCut main process entry.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, Menu, dialog } from 'electron'
import { registerIpc } from './ipc'
import { handleProtocols, registerSchemes } from './protocols'
import { hardenApp, hardenSession } from './security'
import { createServices, type AppServices } from './services'
import { initLog, logger } from './util/log'
import { resolvePaths } from './paths'

const devServer = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const appDir = app.getAppPath()
const resources = app.isPackaged ? join(process.resourcesPath, 'resources') : join(appDir, 'resources')

app.setAppUserModelId('io.github.jypy933.crapcut')
registerSchemes()
hardenApp(devServer)

let win: BrowserWindow | null = null
let services: AppServices | null = null

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore()
      win.focus()
    }
  })
  void app.whenReady().then(start)
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: 1320,
    height: 840,
    minWidth: 1000,
    minHeight: 660,
    show: false,
    title: 'CrapCut',
    backgroundColor: '#0d0e10',
    titleBarStyle: 'hidden',
    titleBarOverlay: { color: '#0d0e10', symbolColor: '#8b8f98', height: 40 },
    icon: join(resources, 'icon.png'),
    webPreferences: {
      preload: join(appDir, 'out', 'preload', 'index.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      allowRunningInsecureContent: false,
      spellcheck: false,
      devTools: !app.isPackaged
    }
  })
  w.once('ready-to-show', () => w.show())
  // Development only: save a screenshot of the window (used to check the UI from scripts).
  const capture = !app.isPackaged ? process.env.CRAPCUT_DEV_CAPTURE : undefined
  if (capture) {
    w.webContents.once('did-finish-load', () => {
      setTimeout(() => {
        void w.webContents.capturePage().then((img) => {
          writeFileSync(capture, img.toPNG())
          if (process.env.CRAPCUT_DEV_CAPTURE_EXIT) app.quit()
        })
      }, Number(process.env.CRAPCUT_DEV_CAPTURE_DELAY ?? 4000))
    })
  }
  w.on('closed', () => {
    win = null
  })
  if (devServer) void w.loadURL(devServer)
  else void w.loadURL('app://bundle/index.html')
  return w
}

async function start(): Promise<void> {
  const paths = resolvePaths({ resources })
  initLog(paths.logs)
  const log = logger('main')
  log.info(`CrapCut ${app.getVersion()} starting (packaged=${app.isPackaged})`)
  process.on('uncaughtException', (err) => log.error('uncaught', err))
  process.on('unhandledRejection', (err) => log.error('unhandled rejection', err))

  if (app.isPackaged) Menu.setApplicationMenu(null)
  hardenSession()
  handleProtocols(paths, join(appDir, 'out', 'renderer'))

  try {
    services = await createServices(resources, () => win)
  } catch (err) {
    log.error('startup failed', err)
    dialog.showErrorBox('CrapCut could not start', 'Something went wrong while starting. The log file has details.')
    app.quit()
    return
  }
  registerIpc(services, () => win, devServer)
  win = createWindow()
  services.updater.start()
  services.channelWatch.start()

  app.on('activate', () => {
    if (!win) win = createWindow()
  })
}

app.on('window-all-closed', () => app.quit())

// Running jobs pause (and can continue next time); child tools are stopped.
let quitting = false
app.on('will-quit', (event) => {
  if (quitting || !services) return
  event.preventDefault()
  quitting = true
  const s = services
  s.updater.stop()
  s.channelWatch.stop()
  const timeout = new Promise((r) => setTimeout(r, 8000))
  void Promise.race([Promise.all([s.runner.shutdown(), s.exporter.shutdown()]), timeout]).finally(() => {
    s.store.close()
    app.exit(0)
  })
})
