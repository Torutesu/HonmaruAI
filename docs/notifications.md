# Notifications

> The feed's promise is *open the app and the decision is already there*.
> That assumes you knew to open it. This is the part that tells you.

One hub, `worker/src/notify.js`, and three channels. Every place a card
changes hands — the relay, the 15-minute sync, the inbound email webhook —
calls the hub once and moves on. The hub decides who is told, in what
language, and on what.

| Channel | Reaches | Needs | File |
|---------|---------|-------|------|
| **APNs** | the iOS app | the App ID entitlement and four secrets ([push-notifications.md](push-notifications.md)) | `apns.js` |
| **Web Push** | any browser, Android, an iPhone with the site on its home screen (iOS 16.4+), a desktop shell around a browser | a VAPID key pair, three secrets | `webpush.js` |
| **Email** | anyone with an address, when nothing above delivered | Mailgun, two secrets | `mailer.js` |

The first two are pushes. Email is the floor: it goes out only when no push
arrived — no device, no browser, or every one of them came back dead — and
the person has an address and has not switched it off. Nobody is told twice.

## In the reader's language

A notification is composed on the server, and the server knows what each
person reads. `users.locale` is:

- **seeded** on the first sign-in from `Accept-Language`, which URLSession
  and every browser send without being asked;
- **set** explicitly by the app's language toggle (`PUT /me {locale}`) and by
  the web client from `navigator.language`;
- **never overwritten** by anything else. Loading the org graph used to reset
  every teammate to English; `upsertUser` now keeps a stored locale unless a
  caller actually passes one.

Every string a notification can say is in `notifyCopy.js`, in English and
Japanese, with English as the fallback for a language we have not written.
Adding one is adding a block.

The **card itself** is written by the router in the *sender's* language,
because the sender's app is the only thing the router knows. The relay is the
first place that knows the recipient too, so on `card_created` it translates
the title, summary and context into the recipient's language with one model
call (`localize.js`), stores the result on the card as `localized[locale]`,
and re-broadcasts it. The notification uses that title; the web client shows
it; the original fields are untouched, so the sender still reads their own
words and the "decided" alert they get back is in their language.

The translation is skipped whenever it would change nothing (same language,
already translated, no model configured) and is paid from the sender's AI
allowance, so a socket loop creating cards cannot run up a bill the meter
never saw.

## What is sent

| Trigger | Kind | Who is told |
|---------|------|-------------|
| A card is routed to you | `created` | you, unless you routed it to yourself |
| A card you sent is decided | `decided` | you, unless you decided it |
| The sender nudges | `nudged` | the recipient |
| A sync creates several cards | `digest` | you, once for the batch |

The body is the **title and the routing line only** — never the summary. A
lock screen is a public surface and a summary can carry a salary.
`apns-collapse-id` and the Web Push `Topic` are the card id, so a card
created and then decided collapses to one notification.

## Web Push — setup

```bash
cd worker
node scripts/vapid-keys.mjs           # prints a fresh pair
npx wrangler secret put VAPID_PUBLIC_KEY
npx wrangler secret put VAPID_PRIVATE_KEY
npx wrangler secret put VAPID_SUBJECT   # mailto:you@example.com
npx wrangler secret put APP_WEB_URL     # optional: where a tap or an email link opens
```

`GET /health` reports `webPush: true` once the three are set. The keys are in
the format `web-push` prints, so a pair generated with that tool works too.

The web client (`web-react/`) registers `public/sw.js`, shows a bell in the
top bar until notifications are on, and on a click asks permission,
subscribes, and posts the subscription to `POST /push/subscriptions`. The
Worker binds it to the session's login — never to a login the browser
claims — and encrypts every payload to the subscription's own keys
(RFC 8291, `aes128gcm`), so the push service in between relays bytes it
cannot read. Signing out unsubscribes and forgets it on the server.

On an iPhone the bell says the true thing instead: add the site to the home
screen first, because Safari only exposes push to an installed web app. The
manifest and `apple-mobile-web-app-capable` meta in `index.html` are what
make it installable.

## Email — setup

Either provider. The choice is not really ours: whoever runs a deployment has
to get credentials from somewhere, and "somewhere" keeps changing its free
tier. `./worker/scripts/setup-email.sh` asks which, sets it, deploys, and then
sends a real message so a wrong key is found here rather than by whoever was
waiting for a code.

**Resend** — one key, no domain, no DNS. Until a domain is verified it only
delivers to the address that owns the Resend account, which is enough to test
with.

```bash
npx wrangler secret put RESEND_API_KEY     # https://resend.com/api-keys
npx wrangler secret put NOTIFY_EMAIL_FROM  # optional; without it, Resend's shared sender
```

**Mailgun** — needs a sending domain, and is also what the inbound email
connector uses, so pick it if you want mail to come *in* as well.

```bash
npx wrangler secret put MAILGUN_API_KEY
npx wrangler secret put MAILGUN_DOMAIN     # the sending domain, e.g. mg.example.com
npx wrangler secret put NOTIFY_EMAIL_FROM  # optional: "Honmaru AI <no-reply@mg.example.com>"
npx wrangler secret put MAILGUN_API_BASE   # optional: https://api.eu.mailgun.net for an EU domain
```

Resend wins when both are set. `/health` reports `emailProvider`, so "mail is
on but nothing arrives" starts from a fact rather than from remembering what
was set up months ago; the refusal itself is in `wrangler tail`.

The same credentials carry the **sign-in code** (`POST /auth/otp/request`),
which is the only way in for someone without GitHub — see
[screens.md](screens.md).

Email accounts sign in with their address. A GitHub account adds one under
⋯ → **Email** in the web client (`PUT /me {email}`), and either can switch
the channel off there (`PUT /me {notifyEmail: false}`).

## API

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/me` | login, locale, whether email is on, the supported locales |
| PUT | `/me` | `{ locale?, email?, notifyEmail? }` — a BCP 47 tag is reduced to its language; `email` only for accounts that do not sign in with one |
| GET | `/push/vapid` | the public key a browser subscribes with (503 when unconfigured) |
| POST | `/push/subscriptions` | a `PushSubscription.toJSON()` body, bound to the session |
| DELETE | `/push/subscriptions` | `{ endpoint }` |

## Tests

```
worker/test/notify.test.js     who is told, in what language, on what; email as the floor
worker/test/webpush.test.js    VAPID JWT verified with the public half; encrypt → decrypt with the subscriber's key
worker/test/localize.test.js   language detection; the translation call, its cost, and its absence
worker/test/me.test.js         the locale sticks; Accept-Language seeds a new account
worker/test/push.test.js       the APNs channel, unchanged
```

The Web Push test does what a browser does: generates its own ECDH pair and
auth secret, subscribes, then decrypts what the Worker sent and checks it is
the message — rather than trusting that the derivation is right because it
did not throw.

## Debugging

| Symptom | Cause |
|---------|-------|
| `/health` says `webPush: false` | one of `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT` is missing |
| The bell only shows a hint on an iPhone | the site is open in Safari, not from the home screen |
| The bell says notifications are blocked | the browser's site permission is "Block"; only the browser settings can undo that |
| A push arrives in the wrong language | check `GET /me` — the app toggle and the browser both write it; the last one wins |
| A subscription stops delivering after a while | the push service answered 404/410 and the row was deleted; the client re-subscribes on the next visit |
| Email arrives alongside a push | the push failed (not "was not registered"): APNs or the push service answered with an error |
| No email at all | No `RESEND_API_KEY` and no `MAILGUN_API_KEY`/`MAILGUN_DOMAIN`, the person has no `email`, or `notifyEmail` is off |
