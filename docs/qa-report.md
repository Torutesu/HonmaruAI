# QA report — release candidate, 2026-09-11

What was checked before calling this a product someone can pay for, what was
found, what was fixed, and what is still the owner's to do. Every claim here
is something that ran, not something that was read.

## Suites

| Suite | Before | After |
|-------|--------|-------|
| Worker (`worker/`, real workerd) | 391 pass | 391 pass |
| Web unit (`web-react/`, vitest) | 8 pass | 11 pass |
| Web typecheck + build | clean | clean |
| End to end (`e2e/run.sh`, real Worker + D1 + browser) | 27 steps pass | 28 steps pass |
| iOS (`xcodebuild test`) | not runnable here (Linux) — runs on pull requests in CI | — |

## The web client, screen by screen

Every screen was photographed at 390×844 and 1440×900 in the end-to-end run
(`/tmp/e2e-shots` in CI artifacts) and read as a person would. What was wrong,
and what changed:

### Fixed

- **The feed lied on a cold start.** Before the relay's snapshot arrived the
  feed showed "All clear ✓" — to exactly the person who opened the app to see
  what was waiting. It now shows "Opening your feed…" until the relay has
  answered, and only then "All clear" or the cards.
- **A swipe could not be taken back.** A decision left the screen the moment
  it was made, with no way back: the only rollback button in the code was
  inside a sheet nothing opened, behind a condition (`!card.status`) that
  could never be true. Every decision now leaves six seconds of **Undo** on
  the screen, and History keeps Undo on anything you decided.
- **A decision made offline vanished.** `sendDecision` returned early when
  the socket was not open and said nothing, so the card stayed on screen
  looking undecided. The client now holds outbound messages in an outbox and
  delivers them, in order, once the relay has accepted the next join. The top
  bar says "N waiting to send" until they are gone. Tested against a fake
  socket: held while down, sent after the snapshot, never before the join,
  never twice.
- **Keyboard shortcuts leaked under screens.** With the profile or a sheet
  open, pressing **D** declined the card underneath. The feed's keys are now
  inert whenever anything is over it.
- **Every card's context chip sat in a grey box.** An unused legacy component's
  stylesheet defined `.card-context` globally and painted a box behind the
  feed's chip row. The component (and its sheets, which no button opened) is
  gone; the chips sit on the card as designed.
- **History rows did nothing.** Tapping a settled decision closed History and
  opened a feed that, by definition, did not contain it. A row now opens in
  place: summary, reply, note, the GitHub issue, and Undo where it applies.
- **Urgent cards lit no priority mark.** The legend drew low/medium/high; the
  fourth level the API sends lit nothing. It lights the top of the scale and
  says "Urgent".
- **Half the interface stayed English in Japanese.** Sign-in, the code screen,
  Plans, the delete-account confirmation, the record, the notification
  prompts, in-tab notifications and the crash screen were hard-coded. All go
  through the dictionary now, with Japanese for every key.
- **A render error was a blank white page.** An error boundary shows what
  happened, in the reader's language, with a Reload button.
- **Errors never went away.** The error toast stayed until clicked; it now
  clears itself after eight seconds and is announced (`role="alert"`).
- **Pointer capture on swipe.** A fast swipe that ended off the card left it
  stuck mid-drag; the page captures the pointer for the gesture.
- **The tab title read "Honmaru Decision Feed"**; the app is Honmaru AI.
- **`index.html`** gained a description, Open Graph tags, a light/dark
  `theme-color`, and a `<noscript>` line.
- `App.tsx` set state during render on a missing session (a React warning
  and a double render); it is an effect now.

### Checked and fine

- Welcome, sign-up, code entry, onboarding (three pages and the two questions),
  the feed, the list, compose, History, Tools, Notifications, Plans, You,
  Your team, invite/revoke, join by code, removal and eviction — at both
  sizes, in both languages.
- Nothing spills off a 390px viewport on any screen (the suite asserts it).
- No raw account id or email appears on a card or in a list.
- Dark mode has a variant for every new element.
- Focus ring, `aria-label` on every icon-only control, `aria-modal` on sheets,
  `aria-keyshortcuts` on the two answers, `aria-live` on the page counter and
  the loading state, reduced-motion respected for the spinner and the mark.

## The Worker

See the findings section below, filled in from the security and correctness
review of `worker/src`.

## iOS

Read-only review (no macOS here). Findings below; anything that needs a
compiler is listed as a follow-up rather than applied blind.

## Still the owner's to do

These are configuration and store steps, not code:

- `CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` as GitHub Actions
  secrets, so **Deploy Worker** runs — `main` is ahead of production until
  then ([docs/setup-secrets.md](setup-secrets.md)).
- Turn APNs on in the app: App ID capability, reissued profile, and
  `PushService.isEnabledInThisBuild` ([docs/push-notifications.md](push-notifications.md)).
- Point a Mailgun domain at `POST /webhooks/email` and set
  `MAILGUN_WEBHOOK_SIGNING_KEY` / `INBOUND_EMAIL_DOMAIN`.
- `REVENUECAT_SECRET_KEY` only when billing is meant to be live.
- First App Store submission: the checklist at the end of
  [production-release-plan.md](production-release-plan.md#release-checklist).
