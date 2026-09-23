// The service worker: the app shell kept for offline, and a push turned into
// something on the screen.
//
// The shell — the page, its script and stylesheet, the icon — is cached on
// install and served from the cache when the network is not there, so the
// app opens on a train and the outbox holds what you decide until it can
// send. Cards themselves are not cached here: the relay's snapshot is the
// truth, and the client keeps its own copy of the last one.
//
// The push payload arrives already decrypted by the browser and already
// written in this person's language by the Worker — there is nothing to
// translate here, and nothing to fetch. Show it, and when it is tapped,
// bring the feed to the front on the card it names.

const SHELL = 'honmaru-shell-v1'
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(PRECACHE)).catch(() => {}).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const req = event.request
  if (req.method !== 'GET') return
  const url = new URL(req.url)
  // Only this origin: the Worker is another origin and never cached here —
  // a cached session response would be a stale feed served as fresh.
  if (url.origin !== self.location.origin) return

  // The page: network first, so a deploy shows up, and the shell when the
  // network does not answer.
  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        // Only a page that actually is the app becomes the shell: a 404 or
        // a 5xx during a bad deploy would otherwise be what every offline
        // open shows until the next good one.
        if (res.ok && !res.redirected) {
          const copy = res.clone()
          caches.open(SHELL).then((cache) => cache.put('/', copy)).catch(() => {})
        }
        return res
      }).catch(() => caches.match('/').then((hit) => hit || caches.match('/index.html')))
    )
    return
  }

  // Built assets carry a hash in their name and never change under it;
  // everything else on this origin is small and safe to keep. Cache first,
  // fill from the network.
  event.respondWith(
    caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) {
        const copy = res.clone()
        caches.open(SHELL).then((cache) => cache.put(req, copy)).catch(() => {})
      }
      return res
    }))
  )
})

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
  // The card's own address, so a fresh tab opens on it.
  if (cardId) target.hash = '#/feed/' + encodeURIComponent(cardId)
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
