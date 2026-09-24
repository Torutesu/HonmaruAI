import { t } from './i18n'
import { getLocale, primary } from './locale'

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

/// The same words, written by the Worker in the reader's language — which
/// this page's own tables have only for the five languages its screens are
/// in. Taken from GET /me.
type NotificationCopy = { locale: string; newDecision: string; from: string }
let serverCopy: NotificationCopy | null = null

export function setNotificationCopy(copy: NotificationCopy | null | undefined): void {
  if (copy && typeof copy.newDecision === 'string' && typeof copy.from === 'string') serverCopy = copy
}

function words(from: string): { heading: string; byline: string } {
  // Only while it is still the language being read: a language changed since
  // /me was read goes back to the page's own table until it is read again.
  if (serverCopy && serverCopy.locale === primary(getLocale())) {
    return { heading: serverCopy.newDecision, byline: serverCopy.from.replace('{name}', from) }
  }
  return { heading: t('New decision for you'), byline: t('From {name}', { name: from }) }
}

export function notifyNewDecision(title: string, from: string): void {
  if (typeof Notification === 'undefined') return
  if (Notification.permission !== 'granted') return
  // Don't notify if the user is already looking at the tab.
  if (typeof document !== 'undefined' && document.visibilityState === 'visible') return
  try {
    const { heading, byline } = words(from)
    new Notification(heading, {
      body: `${title}\n${byline}`,
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
