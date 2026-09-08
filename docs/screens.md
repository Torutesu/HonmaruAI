# The screens

Every screen in the Figma file, and what is actually behind it. The web client
(`web-react/`) has all of them; the iOS app has the ones marked **iOS**.

The design system they are all built from is
[docs/design-system.md](design-system.md) — the tokens live in
`web-react/src/theme.css` and the screen-specific styles in
`web-react/src/screens/screens.css`.

## The way in

| Screen | File | Behind it |
|---|---|---|
| Welcome | `screens/Welcome.tsx` | Nothing — one sentence about what happens tomorrow morning |
| Sign in / Create account | `screens/SignIn.tsx` | `POST /auth/otp/request`, or `POST /auth/signup` / `/auth/login` with a password |
| Enter the code (OTP) | `screens/Otp.tsx` | `POST /auth/otp/verify` |
| Onboarding 1–3 + role (**iOS**) | `screens/Onboarding.tsx` | `PUT /me` (`locale`, `role`) |
| Sign in with email (**iOS**) | `Features/Auth/EmailSignInSheet.swift` | The same two endpoints, via `Services/EmailAuthService.swift` |

On iOS the code path sits beside GitHub on the last onboarding screen, and
under **You** for a guest. GitHub is right for the engineer on the team and
wrong for the six people who are not — and an email session has no repository,
so it restores on its own path (`SessionStore.hasSavedEmailSession`, which is
deliberately false whenever a repository is stored, or the launch would take
the email path and skip validating the session's repository).

Its organization comes from the server — a team invite's org, or one of the
person's own — and is kept in the keychain beside the token, because there is
nowhere else to derive it from on the next launch. `SessionStore.clear()`
forgets it, or the next account on that phone would adopt the previous one's
organization before the server ever named theirs.

Email is the front door and a password is the fallback, not the other way
round. A code is the credential that works on a device you have just picked
up, and receiving it proves the address every notification this product sends
depends on. A deployment with no mail configured answers `503` on
`/auth/otp/request`, and the screen switches to the password form and says why
— rather than leaving someone waiting for mail nobody can send.

### The code itself

`worker/src/otp.js`. Six digits, and because that is the whole credential:

- stored as a PBKDF2 hash with its own salt, never in the clear;
- ten minutes, and single-use — a correct code is deleted before the session
  is created;
- five wrong guesses burn it, counted in D1 because the guesses arrive on
  different requests and a Worker isolate does not survive between them;
- one code per address at a time, with a sixty-second resend cooldown;
- the same answer for missing, expired and exhausted, so a guesser learns
  nothing about which of their guesses was once real;
- written in the language of the browser that asked, because someone who has
  never signed in has no stored language yet.

Turning it on is `./worker/scripts/setup-email.sh`: a provider's credentials,
the deploy that puts these endpoints and the `login_codes` table on the
Worker, and then a real request for a code — because a wrong key, an
unverified domain and an unauthorized recipient all look identical from
outside (nothing arrives), and the person who notices is otherwise whoever was
waiting for a code that never came.

Either provider will do (`worker/src/mailer.js`), because the choice is not
really ours: whoever runs a deployment has to get credentials from somewhere,
and "somewhere" keeps changing its free tier.

| Secret | Provider | What it needs |
|---|---|---|
| `RESEND_API_KEY` | Resend | One key. No domain, no DNS — until a domain is verified it only delivers to the account owner's own address, which is enough to test with |
| `MAILGUN_API_KEY` + `MAILGUN_DOMAIN` | Mailgun | A sending domain. Also what the inbound email connector uses |

Resend wins when both are set. `/health` reports `emailProvider`, so "mail is
on but nothing arrives" starts from a fact.

An account created this way has **no password hash at all** rather than a
placeholder — `login()` requires a hash, so it can never be talked into
accepting an empty string as the secret.

## The app

| Screen | File | Behind it |
|---|---|---|
| Feed (**iOS**) | `components/Feed.tsx` | The relay, over AG-UI |
| Classic (**iOS**) | `components/ClassicList.tsx` | The same cards, as a list |
| History | `screens/History.tsx` | The relay's state — no extra fetch, so it is right the moment a decision lands |
| Tools | `screens/Tools.tsx` | `GET /connectors`, `POST /connectors/:id/connect`, `POST /connectors/sync` |
| Notifications | `screens/NotificationSettings.tsx` | `GET/PUT /me`, `/push/vapid`, `/push/subscriptions` |
| You (**iOS**) | `screens/Profile.tsx` | `GET/PUT /me`, `DELETE /account` |
| The record (**iOS**) | `components/RecordSheet.tsx` | `GET /record` |
| Choose your plan | `screens/Plans.tsx` | `GET /billing/status` |

A **screen** takes the viewport; a **sheet** (compose, record, invite) sits
over the feed and closes back to it. That distinction is why `.screen` carries
a `z-index` above the feed's own chrome: without it the top bar and tab bar
float over a screen and swallow taps meant for its back button.

## Roles

The onboarding screen and the profile screen both let you say what you do, and
the router matches on it — "ask the designer to review" finds the person whose
role is `designer`. That makes it a write to `memberships` from an
unprivileged screen, so `setOwnRole` (`worker/src/db.js`) refuses two things:

- a role outside `SELF_ASSIGNABLE_ROLES`, so the picker can never be a
  promotion button;
- **any** change by someone who currently holds standing, so an admin picking
  "designer" on an onboarding screen does not quietly demote themselves out of
  their own organization.

`triager`, `maintainer` and `admin` are granted by an invite or by GitHub.
They are never claimed.

## Plans

`worker/src/plans.js` is the catalog, and it is the catalog for both clients —
a price that disagrees between the web app and the phone is worse than no
price. The App Store remains the seller on iOS.

`GET /billing/status` also reports the ceiling **actually in force**, which is
not the free tier's when there is nothing to sell: with no
`REVENUECAT_SECRET_KEY`, `checkAIAllowance` meters everyone against
`UNBILLED_DAILY_ROUTES` instead. Reporting three there would have the screen
warn people about a limit nobody is enforcing.
