// The whole bridge between the page and the desktop app: that it is the
// desktop app, and a way to bring its window forward (a notification the
// page showed was clicked while the window was in the tray). Nothing else
// from Node or Electron reaches the page.

const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('honmaruDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  show: () => ipcRenderer.send('honmaru:show'),
  openNotificationSettings: () => ipcRenderer.send('honmaru:notification-settings'),
}))
