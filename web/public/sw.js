// Service worker: installable shell + Web Push delivery.
// The relay decides *whether* to push (only pending high/urgent decisions,
// never to a connected user) — this only renders what arrives and routes the
// click to the exact card.

self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    payload = event.data ? event.data.json() : {};
  } catch {
    payload = { title: "New decision", body: event.data ? event.data.text() : "" };
  }

  const cardID = payload.cardID;

  event.waitUntil(
    self.registration.showNotification(payload.title || "New decision", {
      body: payload.body || "",
      // Same card twice replaces rather than stacks.
      tag: cardID || "ttfw",
      data: { cardID },
      badge: "/icon.svg",
      icon: "/icon.svg",
    })
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const cardID = event.notification.data && event.notification.data.cardID;

  event.waitUntil(
    (async () => {
      const windows = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });

      // Prefer an open tab so the user keeps their place; tell it which card.
      for (const client of windows) {
        if ("focus" in client) {
          await client.focus();
          client.postMessage({ type: "open-card", cardID });
          return;
        }
      }

      await self.clients.openWindow(cardID ? `/?card=${encodeURIComponent(cardID)}` : "/");
    })()
  );
});
