# Shipping

Two buttons, and a one-time setup that hands GitHub the credentials it needs.

Everything here used to be a local checklist — deploy the Worker, remember to
migrate D1 first, archive on a Mac, upload. The order matters and getting it
wrong breaks sign-in for everyone, so it is automated instead.

The local path (`scripts/release.sh`) still works and is documented in
[app-store-release.md](app-store-release.md). It is the fallback, not the
default.

---

## The backend: automatic

**Actions → Deploy Worker** runs on every push to `main` that touches `worker/`,
and can be run by hand.

It tests, migrates D1, deploys, then checks `/health` actually answers. The
migration runs before the deploy every time — that ordering is the whole reason
this is a workflow and not a habit.

### Setup, once

Settings → Secrets and variables → Actions:

| Secret | Where it comes from |
|--------|---------------------|
| `CLOUDFLARE_API_TOKEN` | Cloudflare dashboard → My Profile → API Tokens → Create Token. Needs **Edit Cloudflare Workers** plus **D1:Edit** |
| `CLOUDFLARE_ACCOUNT_ID` | The hex string in the Cloudflare dashboard URL |

Until both are set the workflow stops on the first step and says which is
missing, rather than failing halfway through a deploy.

---

## The app: one button, after the signing material is handed over

**Actions → TestFlight → Run workflow**, with a version number.

It generates the project, runs the Release smoke launch, archives, exports and
uploads. The build number comes from App Store Connect so it cannot collide with
one already there.

### Setup, once

| Secret | Where it comes from |
|--------|---------------------|
| `ASC_KEY_ID` | App Store Connect → Users and Access → Integrations → App Store Connect API |
| `ASC_ISSUER_ID` | Same page |
| `ASC_KEY_P8` | The `.p8` file's contents. Apple lets you download it exactly once |
| `DEVELOPMENT_TEAM` | Your 10-character team id |
| `DIST_CERT_P12` | `base64 -i dist.p12 \| pbcopy` |
| `DIST_CERT_PASSWORD` | The password that `.p12` was exported with |
| `PROVISIONING_PROFILE` | `base64 -i "HonmaruAI AppStore.mobileprovision" \| pbcopy` |

If the certificate and profile do not exist yet, create them once by following
[app-store-release.md](app-store-release.md#create-the-distribution-certificate-and-profile),
then export what you already have on the Mac:

```bash
# The .p12, from Keychain Access → your "iPhone Distribution" certificate →
# right-click → Export. Or, if you still have dist.key from the original setup:
openssl pkcs12 -export -inkey dist.key -in dist.pem -out dist.p12 \
  -passout pass:CHANGEME -macalg sha1 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES

base64 -i dist.p12 | pbcopy                                    # → DIST_CERT_P12
base64 -i ~/Library/MobileDevice/Provisioning\ Profiles/*.mobileprovision | pbcopy
                                                               # → PROVISIONING_PROFILE
```

> **This workflow has never run.** It performs the same steps
> `scripts/release.sh` does, but signing on a fresh runner is the part of iOS
> releasing that fails in ways only a real attempt reveals. Expect to iterate on
> the first run. The archive is uploaded as a build artifact either way, so a
> failed upload does not mean a lost build.

---

## Order, when both change

The app and the Worker are one product with a version skew problem, and it cuts
both ways:

- **App before Worker.** The current app calls `GET /oauth/github/state`, which a
  Worker that has not been redeployed does not serve. Sign-in dies outright.
- **Worker before app.** A build already on testers' phones posts to
  `/oauth/github/token` with no `state`, which the redeployed Worker refuses.
  *Fresh* sign-in on the old build breaks.

Nobody already signed in is affected either way — session tokens keep working,
and a session extends every time it is used. So **the Worker goes first**, and
the TestFlight run follows immediately.

Merging to `main` deploys the Worker on its own. Start the TestFlight run once
that workflow is green.

---

## What is still manual, and honestly cannot be otherwise

- **Creating the App Store Connect API key and the distribution certificate.**
  One-time, and Apple only lets a human do it.
- **Enabling Push Notifications on the App ID** and reissuing the profile, when
  push is turned on — see [push-notifications.md](push-notifications.md).
- **Hosting the privacy policy.** `privacy-policy.md` is the text; App Store
  review needs it at a reachable URL. GitHub Pages on this repo is enough.
- **Submitting for App Store review.** TestFlight is automated; a submission is
  a decision, and `scripts/release.sh submit` keeps it behind a confirmation on
  purpose.
