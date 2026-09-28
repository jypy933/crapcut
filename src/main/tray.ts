// The tray icon: a small menu (Open, Quit) and a click to bring the window
// back. Created once for the app's lifetime and destroyed on quit.

import { Menu, Tray } from 'electron'
import { join } from 'node:path'

export function createTray(resources: string, onOpen: () => void, onQuit: () => void): Tray {
  const tray = new Tray(join(resources, 'icon.png'))
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
