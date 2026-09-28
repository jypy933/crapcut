// Electron hardening applied to every window and session.

import { app, session, shell, type WebContents } from 'electron'
import { logger } from './util/log'

const log = logger('security')

/** Origins the app's own pages may load from. */
export function isAppUrl(url: string, devServer: string | undefined): boolean {
  try {
    const u = new URL(url)
    if (u.protocol === 'app:' && u.host === 'bundle') return true
    if (devServer) {
      const d = new URL(devServer)
      return u.origin === d.origin
    }
    return false
  } catch {
    return false
  }
}

/** External pages the UI may open in the user's browser (licences, project page). */
export function isAllowedExternal(url: string, allowed: ReadonlySet<string>): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'https:' && allowed.has(u.toString())
  } catch {
    return false
  }
}

export function hardenApp(devServer: string | undefined): void {
  app.on('web-contents-created', (_e, contents: WebContents) => {
    contents.setWindowOpenHandler(() => ({ action: 'deny' }))
    contents.on('will-navigate', (event, url) => {
      if (!isAppUrl(url, devServer)) {
        event.preventDefault()
        log.warn('blocked navigation', url)
      }
    })
    contents.on('will-redirect', (event, url) => {
      if (!isAppUrl(url, devServer)) event.preventDefault()
    })
    contents.on('will-attach-webview', (event) => event.preventDefault())
  })
}

export function hardenSession(): void {
  const s = session.defaultSession
  s.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  s.setPermissionCheckHandler(() => false)
  s.setDevicePermissionHandler(() => false)
  // The UI never needs to download anything itself.
  s.on('will-download', (event) => event.preventDefault())
}

export function openExternalSafely(url: string, allowed: ReadonlySet<string>): void {
  if (isAllowedExternal(url, allowed)) void shell.openExternal(url)
  else log.warn('blocked external link', url)
}
