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

The whole of it is `RESEND_API_KEY` (`worker/src/mailer.js`): no domain, no
DNS records, and a free tier that is a free tier rather than a trial. Until a
domain is verified at Resend, mail only reaches the address that owns the
Resend account — enough to test with, and the difference between working in
two minutes and working after a DNS change.

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

## Teams, and getting into one

An invite code is minted under **You → Invite a teammate** (`POST
/invites/create`) and redeemed in three places, which between them cover the
three states a person can be in:

| They are… | Where the code goes | What redeems it |
|-----------|--------------------|-----------------|
| New here | Sign in / Create account → **Invite code** | `POST /auth/signup`, or `/auth/otp/verify` creating the account |
| Signed out, but they have an account | The same field, in **Sign in** mode too | `/auth/otp/verify` or `/auth/login`, which now redeem one |
| Already signed in | **You → Join a team** | `POST /invites/accept` |

The middle and bottom rows did not work at all. The field was drawn only in
sign-up mode, `verifyCode` read `inviteCode` and used it only when it was
creating an account, and `/invites/accept` had no caller in either client —
so an invite reached exactly the people who did not have an account yet, and
silently did nothing for everyone else. There was no error, and the code was
not even spent.

A code that fails never costs the sign-in: the emailed six digits were the
credential and they were right, so the session stands and the reply carries
`inviteError` for the screen to show.

### Seeing a team, not only adding to it

**You → Your team** is the whole of it: who is here, the codes still out, and
the form that mints another. Before it there was no member list at all — the
only endpoint that answered "who is here" was `/orgs/:owner/:repo/graph`,
which reads a GitHub repository's collaborators and needs a GitHub session, so
for every account the web client can sign in it answered nothing.

| Route | Who may call it | What it refuses |
|-------|-----------------|-----------------|
| `GET /members?orgId=` | any member | a non-member, with 403 |
| `DELETE /members` | any member | removing someone at or above your own role; the last person leaving; any change at all to a repository-backed org |
| `GET /invites?orgId=` | any member | showing, in full, a code minted above your own role |
| `DELETE /invites` | the code's creator, or standing at or above what it grants | anyone else's, with 403 |

Three of those deserve their reasons written down:

- **A repository-backed org is not ours to edit.** `retainMemberships` deletes
  anyone GitHub no longer lists on the next org-graph load, so a row deleted
  here comes straight back. `editable: false` says where membership is really
  decided instead of offering a button that quietly undoes itself.
- **A code above your own role is listed by reference, not in full.** Reading
  an admin code is a promotion — redeem it and you are one — and the same
  ladder that stops you *minting* one has to stop you reading one. A code at
  or below your role you could mint yourself, so showing it hands you nothing.
  The reference is `sha256(code)` cut to 16 characters: derived, not stored,
  because one more column on `invites` is a migration for a computable string.
- **The last person cannot leave.** An org with nobody in it is a row nothing
  can ever reach again, its cards included, and no invite can be minted to get
  back in.

Removing someone takes nothing of theirs but the membership. What was decided
is the organization's record, not the decider's belongings —
[the privacy policy](privacy-policy.md) draws the same line for account
deletion.

### Which workspace you land in

`GET /me` returns `orgs`: every workspace this person belongs to, with the
role they hold and — for a `personal:<hash>` org, which has no readable name —
whoever created it, so the switcher can say "Dana's team" rather than an id.
More than one, and **You → Where you work** lists them.

Every sign-in reply (`/auth/signup`, `/auth/login`, `/auth/otp/verify`) names
an `orgId`. Only sign-up used to: signing in as an existing account returned
none, and the web client fell back to a hardcoded `web-team` — an org nobody
is a member of, so the relay refused the socket and a second browser simply
never showed a feed. Where there is no stored preference the server picks
`primaryOrgId`: a workspace with other people in it beats a solo one, ties to
the earliest join. Not "is it a `personal:` org" — an inviter's own workspace
is a personal one too, and that test sent everyone they invited back to their
own empty feed.

## Tools, and what this workspace can actually do

`GET /connectors/github?orgId=` answers one question: can a decision made here
become a GitHub Issue? It is a route of its own rather than a field on
`GET /connectors` because that one refuses outright without a Composio key,
and this answer has nothing to do with Composio.

It says no twice: a workspace that is not `owner/repo` has nowhere to open an
issue, and an email session has no GitHub token to write with. The Tools
screen printed **Always on · Built in** to everybody, which for an email
account in the `personal:` workspace it was given at sign-up was true of
nothing at all.

## Plans

`worker/src/plans.js` is the catalog, and it is the catalog for both clients —
a price that disagrees between the web app and the phone is worse than no
price. The App Store remains the seller on iOS.

`GET /billing/status` also reports the ceiling **actually in force**, which is
not the free tier's when there is nothing to sell: with no
`REVENUECAT_SECRET_KEY`, `checkAIAllowance` meters everyone against
`UNBILLED_DAILY_ROUTES` instead. Reporting three there would have the screen
warn people about a limit nobody is enforcing.
