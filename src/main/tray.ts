// The tray icon: a small menu (Open, Quit) and a click to bring the window
// back. Created once for the app's lifetime and destroyed on quit.

import { Menu, nativeImage, Tray, type NativeImage } from 'electron'
import { join } from 'node:path'

export function createTray(resources: string, onOpen: () => void, onQuit: () => void): Tray {
  const tray = new Tray(trayIcon(join(resources, 'icon.png')))
  tray.setToolTip('CrapCut')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Open', click: onOpen },
      { type: 'separator' },
      { label: 'Quit', click: onQuit }
    ])
  )
  tray.on('click', onOpen)
  return tray
}

// The shipped icon is 512x512. Give Windows a pre-shrunk copy for each common
// display scale, so the 16 px tray slot stays crisp at 100% to 200%.
function trayIcon(file: string): NativeImage {
  const source = nativeImage.createFromPath(file)
  const icon = nativeImage.createEmpty()
  for (const scaleFactor of [1, 1.25, 1.5, 2]) {
    const size = Math.round(16 * scaleFactor)
    icon.addRepresentation({ scaleFactor, buffer: source.resize({ width: size, height: size, quality: 'best' }).toPNG() })
  }
  return icon
}
