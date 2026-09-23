import { t } from './i18n'

// In-tab notifications for incoming decisions, for a browser that has granted
// permission but not subscribed to push. Web Push (utils/push.ts) is the real
// channel — it works with the tab closed and is written in the reader's
// language by the Worker. This is the fallback while the tab is open in the
// background. All no-ops if unsupported or not permitted.

export function requestNotificationPermission(): void {
  if (typeof Notification === 'undefined') return
  if (Notification.permission === 'default') {
    Notification.requestPermission().catch(() => {})
  }
}

export function notifyNewDecision(title: string, from: string): void {
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  // Don't notify if the user is already looking at the tab.
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return
  try {
    new Notification(t('New decision for you'), {
      body: `${title}\n${t('From {name}', { name: from })}`,
      tag: 'honmaru-decision',
    })
  } catch {
    // Some browsers throw if constructed outside a user gesture; ignore.
  }
}

// Show an unread count in the browser tab title, e.g. "(2) Honmaru".
export function setTabBadge(count: number): void {
  if (typeof document === 'undefined') return
  const base = 'Honmaru AI'
  document.title = count > 0 ? `(${count}) ${base}` : base
}
