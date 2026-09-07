// The service worker that turns a push into something on the screen.
//
// The payload arrives already decrypted by the browser and already written in
// this person's language by the Worker — there is nothing to translate here,
// and nothing to fetch. Show it, and when it is tapped, bring the feed to the
// front on the card it names.

self.addEventListener('install', () => self.skipWaiting())
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()))

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { title: event.data && event.data.text() } }
  const title = data.title || 'Honmaru AI'
  const options = {
    body: data.body || '',
    tag: data.tag || data.cardId || 'honmaru',
    renotify: Boolean(data.kind === 'nudged'),
    data: { cardId: data.cardId || null, url: data.url || null, kind: data.kind || null },
    icon: '/icon.svg',
    badge: '/icon.svg',
  }
  const work = [self.registration.showNotification(title, options)]
  if (typeof data.badge === 'number' && 'setAppBadge' in navigator) {
    work.push(data.badge > 0 ? navigator.setAppBadge(data.badge) : navigator.clearAppBadge())
  }
  event.waitUntil(Promise.all(work))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const cardId = event.notification.data && event.notification.data.cardId
  const target = new URL(self.registration.scope)
  if (cardId) target.searchParams.set('card', cardId)
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      for (const client of windows) {
        if ('focus' in client) {
          client.postMessage({ type: 'open-card', cardId })
          return client.focus()
        }
      }
      return self.clients.openWindow(target.toString())
    })
  )
})
