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

const SHELL = 'honmaru-shell-v3'
// The Worker's push key, kept by the page (utils/push.ts) for this worker to
// subscribe again with when the browser drops a subscription and says
// nothing about the old one (Firefox for Android does).
const PUSH_KEY_CACHE = 'honmaru-push'
const PUSH_KEY = '/push-key'
const PRECACHE = ['/', '/index.html', '/manifest.webmanifest', '/icon.svg', '/icon-192.png', '/badge-96.png']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(SHELL).then((cache) => cache.addAll(PRECACHE)).catch(() => {}).then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== SHELL && k !== PUSH_KEY_CACHE).map((k) => caches.delete(k))))
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

// Raster images: Chrome does not reliably draw an SVG notification icon, and
// Android's status-bar badge must be a monochrome PNG (only its alpha is
// used). Firefox ignores `badge`, and draws the icon.
const ICON = '/icon-192.png'
const BADGE = '/badge-96.png'

/// What a push says, turned into what the notification shows. Pure, so the
/// shape is tested rather than hoped for (sw.test.ts loads this file).
function notificationFor(data) {
  const tag = data.tag || data.cardId || 'honmaru'
  const at = Date.parse(data.at || '')
  return {
    title: data.title || 'Honmaru AI',
    options: {
      body: data.body || '',
      tag,
      // A second message in a conversation replaces the first (one entry per
      // conversation, as Discord and Slack do) — and must still make a sound
      // and show, or every message after the first arrives in silence. The
      // same for a card: a comment, a mention or its answer replaced what was
      // on screen for it without a sound. Only a repeat of the very same
      // event is quiet (alreadyShown, below).
      // `renotify` without a tag throws in Chrome; the tag is always set.
      renotify: true,
      timestamp: Number.isFinite(at) ? at : Date.now(),
      data: {
        cardId: data.cardId || null,
        messageId: data.messageId || null,
        orgId: data.orgId || null,
        channel: data.channel || null,
        url: data.url || null,
        kind: data.kind || null,
        // The server's time for the message (created_at), the same one the
        // open tab puts on its own notification for it.
        at: data.at || null,
      },
      icon: ICON,
      badge: BADGE,
    },
  }
}

/// The open tab may have shown this very message or card already, the moment
/// its socket heard it (utils/notifications.ts, same tag). Then the push
/// replaces it without a second sound. A push must still show something —
/// `userVisibleOnly` — so it is replaced, never skipped.
function alreadyShown(existing, data) {
  return existing.some((n) => {
    const d = n.data || {}
    return (data.messageId && d.messageId === data.messageId) || (data.cardId && d.cardId === data.cardId && data.kind === d.kind)
  })
}

/// A notification on screen for a later message than this push's (the tab
/// announced a newer one while this push waited its minute).
function newerShown(existing, data) {
  const at = Date.parse(data.at || '')
  if (!Number.isFinite(at)) return null
  return existing.find((n) => {
    const d = n.data || {}
    return d.kind === 'message' && Date.parse(d.at || '') > at
  }) || null
}

async function showPush(data) {
  const { title, options } = notificationFor(data)
  if (options.renotify) {
    const existing = await self.registration.getNotifications({ tag: options.tag }).catch(() => [])
    // Never roll the conversation back to an older message, and never ring
    // for one already announced: show the newer one again, quietly.
    const newer = newerShown(existing, data)
    if (newer) {
      return self.registration.showNotification(newer.title, {
        body: newer.body, tag: options.tag, data: newer.data, timestamp: newer.timestamp,
        icon: ICON, badge: BADGE, renotify: false,
      })
    }
    if (alreadyShown(existing, data)) options.renotify = false
  }
  return self.registration.showNotification(title, options)
}

self.addEventListener('push', (event) => {
  let data = {}
  try { data = event.data ? event.data.json() : {} } catch { data = { title: event.data && event.data.text() } }
  data = data || {}
  const work = [showPush(data)]
  if (typeof data.badge === 'number' && 'setAppBadge' in navigator) {
    work.push((data.badge > 0 ? navigator.setAppBadge(data.badge) : navigator.clearAppBadge()).catch(() => {}))
  }
  event.waitUntil(Promise.all(work))
})

/// Where a tapped notification leads, as this app's address: the card, or
/// the message, in its own workspace (`#/feed/<id>/<orgId>` and
/// `#/m/<id>/<orgId>` switch to it).
function hashFor(data) {
  if (data.cardId) return '#/feed/' + encodeURIComponent(data.cardId) + (data.orgId ? '/' + encodeURIComponent(data.orgId) : '')
  if (data.messageId) return '#/m/' + encodeURIComponent(data.messageId) + (data.orgId ? '/' + encodeURIComponent(data.orgId) : '')
  return ''
}

/// Which open window to bring forward: the one in front, else one that can
/// be seen, else any window of the app itself — never privacy.html or a
/// support page, which cannot open a card.
function pickWindow(windows, scope) {
  const app = windows.filter((c) => {
    try {
      const path = new URL(c.url).pathname.replace(/\/index\.html$/, '/')
      return c.url.startsWith(scope) && !/\.html?$/.test(path)
    } catch { return false }
  })
  return app.find((c) => c.focused) || app.find((c) => c.visibilityState === 'visible') || app[0] || null
}

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const data = event.notification.data || {}
  const hash = hashFor(data)
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windows) => {
      const client = pickWindow(windows, self.registration.scope)
      if (!client) {
        const target = new URL(self.registration.scope)
        target.hash = hash
        return self.clients.openWindow(target.toString())
      }
      // The open app goes there itself (Dashboard listens), rather than a
      // second tab opening beside it.
      client.postMessage(data.messageId && !data.cardId
        ? { type: 'open-message', messageId: data.messageId, orgId: data.orgId || null, hash }
        : { type: 'open-card', cardId: data.cardId || null, orgId: data.orgId || null, hash })
      return 'focus' in client ? client.focus() : undefined
    })
  )
})

// The browser replaced this subscription (Firefox does when it rotates its
// push service keys; any browser may when one expires). Make a new one with
// the same key at once, so pushes keep arriving, and ask any open page to
// hand it to the Worker — the page has the session; this worker does not.
// A page opened later does the same on its own (utils/push.ts resyncWebPush).
self.addEventListener('pushsubscriptionchange', (event) => {
  event.waitUntil((async () => {
    const old = event.oldSubscription
    let key = old && old.options && old.options.applicationServerKey
    // Firefox for Android (and Firefox before 137) says nothing about the
    // old one: subscribe with the key the page kept. None kept means push
    // was turned off here, and stays off.
    if (!key) {
      const kept = await caches.open(PUSH_KEY_CACHE).then((c) => c.match(PUSH_KEY)).catch(() => null)
      key = kept ? await kept.text().catch(() => '') : ''
    }
    const current = await self.registration.pushManager.getSubscription().catch(() => null)
    if (!event.newSubscription && !current && key) {
      await self.registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key }).catch(() => null)
    }
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    for (const client of windows) client.postMessage({ type: 'push-resync' })
  })())
})
