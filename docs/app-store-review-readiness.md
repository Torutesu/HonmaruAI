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

The second must return a `token`. Then in App Store Connect →
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

## 2. Sign in with Apple — Guideline 4.8

**A real risk, and a decision rather than a bug.** Not addressed here, because
every way of addressing it is a product choice.

4.8 applies to apps that use "a third-party or social login service" to set up
the primary account. GitHub sign-in is one. When it applies, you must also offer
an option that:

1. limits collection to name and email,
2. **lets the user keep their email address private**,
3. does not use the data for advertising.

Our email-code sign-in meets 1 and 3 cleanly. It does not meet 2: it needs a
real, reachable address, and there is no relay that hides it the way Apple's own
does. Reviewers apply this inconsistently — plenty of apps ship with
email/password as the alternative — but it is the clause that gets cited.

Three ways out, in order of cost:

- **Drop GitHub sign-in from the iOS app.** 4.8 then does not apply at all.
  GitHub stays a *connector* — the thing it is actually load-bearing for — and
  stops being an identity provider on the phone. Cheapest, and arguably the
  right product call: the phone is for the six people who are not the engineer.
- **Add Sign in with Apple.** Correct and unambiguous. Needs the capability, an
  entitlement, and a Worker route that verifies Apple's identity token.
- **Submit as is.** It may well pass. If it does not, the rejection costs a
  review cycle and you end up doing one of the above anyway.

---

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
2. Decide the 4.8 question. If you drop GitHub from iOS, do it before the
   screenshots — the sign-in screen is usually one of them.
3. Verify a domain at Resend, or accept that only the demo account and your own
   address can sign in.
4. Then follow `app-store-release.md` for the build and the submission.
