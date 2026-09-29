// CrapCut main process entry.

import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, Menu, dialog, type Tray } from 'electron'
import { shouldHideOnClose } from './core/trayPolicy'
import { registerIpc } from './ipc'
import { handleProtocols, registerSchemes } from './protocols'
import { hardenApp, hardenSession } from './security'
import { createServices, type AppServices } from './services'
import { detectHardware } from './tools/gpu'
import { createTray } from './tray'
import { initLog, logger } from './util/log'
import { resolvePaths } from './paths'

const devServer = !app.isPackaged ? process.env.ELECTRON_RENDERER_URL : undefined
const appDir = app.getAppPath()
const resources = app.isPackaged ? join(process.resourcesPath, 'resources') : join(appDir, 'resources')
// Set by the "start with Windows" login item so the app comes up quietly in the tray.
const startedHidden = process.argv.includes('--hidden')

app.setAppUserModelId('io.github.jypy933.crapcut')
registerSchemes()
hardenApp(devServer)

// Started now, while Electron itself is still getting ready; the services
// wait for it (a failure surfaces there, as a startup error).
const hardwareProbe = detectHardware()
hardwareProbe.catch(() => {})

let win: BrowserWindow | null = null
let services: AppServices | null = null
let tray: Tray | null = null
// True once a real quit is underway (tray Quit, an update installing, Windows
// signing the user out, ...); everywhere else, closing the window hides it
// instead. Set from 'before-quit' so it covers every way a quit can start,
// not just the tray menu.
let isQuitting = false

/** Brings the (possibly hidden or minimized) window to the front. */
function showWindow(): void {
  if (!win) {
    win = createWindow()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

const TRAY_HINT_SHOWN_KEY = 'trayHintShown'

/** The first time the window hides to the tray, a short balloon explains where it went. */
function showTrayHintOnce(s: AppServices): void {
  if (!tray || s.store.get<boolean>(TRAY_HINT_SHOWN_KEY)) return
  s.store.set(TRAY_HINT_SHOWN_KEY, true)
  tray.displayBalloon({ title: 'CrapCut', content: 'CrapCut is still running here.', iconType: 'none' })
}

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
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
  // Launched by the "start with Windows" login item: come up quietly in the tray.
  w.once('ready-to-show', () => {
    if (!startedHidden) w.show()
  })
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
  // A job, an export or a watched channel still needs the app: hide to the
  // tray instead of quitting. A real quit (tray Quit, an update installing,
  // an app menu quit, ...) sets isQuitting first, via 'before-quit', and is
  // let through untouched.
  w.on('close', (event) => {
    if (isQuitting || !services) return
    const state = {
      jobRunning: services.runner.hasWork(),
      exportRunning: services.exporter.hasWork() || services.bestOf.hasWork(),
      channelWatched: services.channelWatch.status().channel !== null
    }
    if (shouldHideOnClose(state)) {
      event.preventDefault()
      w.hide()
      showTrayHintOnce(services)
    }
  })
  // Windows is ending the session (shutdown, restart or sign-out): let the
  // window close for real instead of hiding it, so the OS is not held up.
  w.on('query-session-end', () => {
    isQuitting = true
  })
  w.on('session-end', () => {
    isQuitting = true
  })
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
    services = await createServices(resources, () => win, hardwareProbe)
  } catch (err) {
    log.error('startup failed', err)
    dialog.showErrorBox('CrapCut could not start', 'Something went wrong while starting. The log file has details.')
    app.quit()
    return
  }
  registerIpc(services, () => win, devServer)
  win = createWindow()
  tray = createTray(resources, () => showWindow(), () => app.quit())
  services.updater.start()
  services.channelWatch.start()

  app.on('activate', () => showWindow())
}

// Every way a quit can start (tray Quit, "Restart to update", an app menu
// quit, ...) goes through app.quit(), which fires this before it starts
// closing windows. Setting the flag here, rather than only where quit is
// requested, means the window's 'close' handler never hides it to the tray
// mid-quit (electron-updater's quitAndInstall already spawns the installer
// before calling app.quit(), so cancelling the quit there would leave the
// installer racing a still-running app).
app.on('before-quit', () => {
  isQuitting = true
})

app.on('window-all-closed', () => app.quit())

// Running jobs pause (and can continue next time); child tools are stopped.
let quitting = false
app.on('will-quit', (event) => {
  if (quitting || !services) return
  event.preventDefault()
  quitting = true
  tray?.destroy()
  tray = null
  const s = services
  s.updater.stop()
  s.channelWatch.stop()
  const timeout = new Promise((r) => setTimeout(r, 8000))
  void Promise.race([Promise.all([s.runner.shutdown(), s.exporter.shutdown(), s.bestOf.shutdown()]), timeout]).finally(() => {
    s.store.close()
    app.exit(0)
  })
})
