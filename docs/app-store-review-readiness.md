# Can this app pass review?

`app-store-release.md` covers how to *ship* a build. This is the other half:
what App Store review will do with it once it arrives, and the two things that
would have failed the first submission.

Both were found by reading the app the way a reviewer meets it — with no
GitHub account, no access to our mailbox, and no context.

---

## 1. A reviewer could not sign in — Guideline 2.1

**This would have been rejected.** Not "might": an app the reviewer cannot get
into is returned every time, usually with a screenshot of the sign-in screen.

The app had two doors, and a reviewer can walk through neither:

| Door | Why it fails for a reviewer |
| --- | --- |
| GitHub | They will not create a GitHub account to test an app, and Apple's own guidance says they should not have to. |
| Email code | The code is real mail, sent by Resend. Until a domain is verified there, Resend's shared sender **delivers only to the address that owns the Resend account** — so a code addressed to the reviewer is accepted by the API and never arrives. |

The second one is the trap: `/auth/otp/request` answers `{"ok":true}` for an
address it cannot reach, deliberately, because saying otherwise tells a stranger
which addresses have accounts here. From the reviewer's side it looks exactly
like a broken app.

### What was done about it

A **password sign-in** now exists on iOS. The Worker has had `/auth/login` all
along and the web client uses it; only the phone had no route to it. It sits
behind "Use a password instead" on the sign-in sheet, and a deployment that
cannot send mail at all now lands there instead of telling people to use GitHub
— which was a dead end for exactly the people email sign-in was added for.

### What you still have to do

**Make a demo account and put it in the review notes.** Two commands:

```bash
# 1. Create it. Use an address you control; it never receives mail.
curl -sS -X POST https://tiktokforwork.torubj0904.workers.dev/auth/signup \
  -H 'content-type: application/json' \
  -d '{"email":"appreview@yourdomain.com","password":"<a long random one>","name":"App Review"}'

# 2. Prove it works, the way the reviewer will.
curl -sS -X POST https://tiktokforwork.torubj0904.workers.dev/auth/login \
  -H 'content-type: application/json' \
  -d '{"email":"appreview@yourdomain.com","password":"<the same one>"}'
```

The second must return a `token`.

A step-by-step Japanese walkthrough of the App Store Connect side — which
screen, which checkbox, what to write in the notes — is in
[app-review-signin-ja.md](app-review-signin-ja.md).

Then in App Store Connect →
**App Review Information** → *Sign-in required*, give that address and password,
and in the notes:

> Tap **Sign in with email** → **Use a password instead**, and use the account
> above. GitHub sign-in is optional and not needed to review the app.

Do not skip the notes. Without them a reviewer lands on a screen offering
GitHub and a code, and the password route is one tap away but not obvious.

**Or** verify a domain at Resend, and the email code reaches anyone — which you
want anyway, because until then the same limit applies to every real user you
invite, not only to the reviewer.

---

## 2. Sign in with Apple — Guideline 4.8 — resolved by removing the cause

**Settled: GitHub is no longer a way into the app on the phone.**

4.8 applies to apps that use "a third-party or social login service" to set up
the primary account, and then requires an alternative that lets a person keep
their email address private. Our emailed code cannot do that — there is no
relay — so offering GitHub sign-in meant owing Apple a Sign in with Apple we do
not have.

Rather than build one, the cause is gone. It was also the wrong default: GitHub
is right for the engineer on the team and wrong for the six people who are not,
and the phone is where those six are. The engineer sets the repository-backed
workspace up on the web, where GitHub sign-in is untouched, and invites them; an
invite code brings them into it from the phone.

What changed, precisely:

- **Onboarding** ends on email, with "continue without signing in" underneath.
  The GitHub step, its repository picker and its OAuth call are gone.
- **The connect sheet** no longer signs anyone in. It is offered only to someone
  who already has a GitHub token — a repository picker for an existing account,
  not a door.
- **You** shows the GitHub row only to those people, and **the feed's** local-mode
  chip no longer offers a button that cannot finish.
- **Anyone already signed in with GitHub stays signed in.** Session restore is
  untouched; this removed the door, not the lock.

GitHub remains what it is actually load-bearing for: decisions syncing to Issues
and Pull Requests, for a workspace that has a repository.

So 4.8 no longer applies. If GitHub sign-in ever returns to iOS, it comes back
with Sign in with Apple beside it.

## 3. Push asks for a permission that cannot be honoured yet

`/health` reports `"push": false` — APNs is not configured on the Worker — while
the app still asks for notification permission once you have earned it
(`requestAuthorizationIfEarned`). Nothing is rejected for this, and a reviewer
is unlikely to reach it, but a person who says yes gets nothing, forever, with
no way to tell why.

Either finish APNs before release (`docs/push-notifications.md`), or gate the
prompt on the Worker actually being able to deliver. Web Push is unaffected and
works today.

---

## Already handled — don't re-litigate these

Checked against the current tree, so a review does not spend time on them:

- **`PrivacyInfo.xcprivacy`** — present and complete: no tracking, four declared
  data types, and required-reason codes for UserDefaults (CA92.1), file
  timestamps (C617.1) and disk space (E174.1). Verify it is *inside* the built
  `.ipa` (`unzip -l build/*.ipa | grep xcprivacy`) — a manifest in the wrong
  build phase fails review exactly as if it were absent.
- **Account deletion** (5.1.1(v)) — **You → Delete account**, backed by
  `DELETE /account`.
- **Export compliance** — `ITSAppUsesNonExemptEncryption` is set in `Info.plist`.
- **Device family** — iPhone only, portrait only, consistent; a mismatch here is
  the ITMS-90474 upload rejection.
- **App icon** — a single 1024×1024 in the asset catalogue is the modern format;
  Xcode generates the rest. Nothing further is needed.
- **Signing** — Release is manual against an App Store profile, so an archive
  does not need a registered device.
- **Japanese** — every user-facing string in the app is localised (421 keys,
  none missing), so the Japanese screenshots will match the Japanese binary.

---

## The order to do it in

1. Create the demo account and check `/auth/login` returns a token.
2. Take the screenshots *after* pulling this branch — the sign-in screen
   changed, and it is usually one of them.
3. Verify a domain at Resend, or accept that only the demo account and your own
   address can sign in.
4. Then follow `app-store-release.md` for the build and the submission.
