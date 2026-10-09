import { desktopApp } from './desktop'
import { loadSoundSettings } from './sound'
import { t } from './i18n'

const KEY = 'honmaru.desktop-notifications'
export const DESKTOP_NOTIFICATION_CHANGE = 'honmaru-desktop-notifications'
/// On unless the person switched it off. It used to be off until switched
/// on, so anyone who never found the switch — or whose app storage started
/// over, as the sandboxed Mac build's does — heard nothing on the desktop,
/// while the server, seeing them active there, held back their phone's push
/// too. The system's own permission still has to be granted.
export function desktopNotificationsEnabled(): boolean {
  try { return localStorage.getItem(KEY) !== 'off' } catch { return true }
}
export function setDesktopNotificationsEnabled(enabled: boolean): void {
  localStorage.setItem(KEY, enabled ? 'on' : 'off')
  window.dispatchEvent(new Event(DESKTOP_NOTIFICATION_CHANGE))
}
export async function enableDesktopNotifications(): Promise<boolean> {
  if (!desktopApp() || typeof Notification === 'undefined') return false
  const permission = Notification.permission === 'granted' ? 'granted' : await Notification.requestPermission()
  if (permission !== 'granted') return false
  setDesktopNotificationsEnabled(true)
  return true
}
export function testDesktopNotification(): void {
  if (!desktopNotificationsEnabled() || Notification.permission !== 'granted') throw new Error('Notifications are not enabled')
  const sounds = loadSoundSettings()
  const notification = new Notification(t('Honmaru notification test'), {
    body: t('If you can see this, notifications can reach this Mac.'), tag: 'honmaru-notification-test', silent: !sounds.enabled || sounds.volume === 0,
  })
  notification.onclick = () => { desktopApp()?.show(); notification.close() }
}
