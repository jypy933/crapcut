// The tray icon: a small menu (Open, Quit) and a click to bring the window
// back. Created once for the app's lifetime and destroyed on quit.

import { Menu, nativeImage, Tray } from 'electron'
import { join } from 'node:path'

export function createTray(resources: string, onOpen: () => void, onQuit: () => void): Tray {
  // The shipped icon is 512x512; shrink it so Windows' small tray area stays crisp.
  const icon = nativeImage.createFromPath(join(resources, 'icon.png')).resize({ width: 16, height: 16 })
  const tray = new Tray(icon)
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
