import { app, shell, Menu, Tray, nativeImage } from 'electron'
import trayIcon from '../../../resources/icon.png?asset'
import { configPath } from '../config'
import * as settings from './settings'

let tray: Tray | null = null

export function get(): Tray | null {
  return tray
}

export function create(): void {
  tray = new Tray(nativeImage.createFromPath(trayIcon).resize({ width: 16, height: 16 }))
  tray.setToolTip('Lumen')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Settings', click: () => settings.create() },
      { label: 'Open config folder', click: () => shell.showItemInFolder(configPath()) },
      { type: 'separator' },
      { label: 'Quit', click: () => app.quit() }
    ])
  )
  tray.on('click', () => settings.create())
}
