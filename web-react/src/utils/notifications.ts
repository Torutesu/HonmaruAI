// Browser desktop notifications for incoming decisions. All no-ops if the
// browser doesn't support them or the user hasn't granted permission.

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
    new Notification('New decision for you', {
      body: `${title}\nFrom ${from}`,
      tag: 'honmaru-decision',
    })
  } catch {
    // Some browsers throw if constructed outside a user gesture; ignore.
  }
}

// Show an unread count in the browser tab title, e.g. "(2) Honmaru".
export function setTabBadge(count: number): void {
  if (typeof document === 'undefined') return
  const base = 'Honmaru Decision Feed'
  document.title = count > 0 ? `(${count}) ${base}` : base
}