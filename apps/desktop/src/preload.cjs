// The whole bridge between the page and the desktop app: that it is the
// desktop app, and a way to bring its window forward (a notification the
// page showed was clicked while the window was in the tray). Nothing else
// from Node or Electron reaches the page.

const { contextBridge, ipcRenderer } = require('electron')

// Whether anybody is at the window, as the main process sees it
// (src/attention.js): the page reads it beside document.visibilityState,
// which in this app always says "visible". A change is announced as a
// visibilitychange, so everything that already listens for one looks again.
let away = false
ipcRenderer.on('honmaru:attention', (_event, value) => {
  const next = Boolean(value)
  if (next === away) return
  away = next
  document.dispatchEvent(new Event('visibilitychange'))
})

contextBridge.exposeInMainWorld('honmaruDesktop', Object.freeze({
  isDesktop: true,
  platform: process.platform,
  away: () => away,
  show: () => ipcRenderer.send('honmaru:show'),
  openNotificationSettings: () => ipcRenderer.send('honmaru:notification-settings'),
}))
