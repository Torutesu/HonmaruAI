# App Store release with `asc`

Ship Honmaru AI — TestFlight builds and App Store review submissions — from
the terminal, without opening App Store Connect in a browser.

Everything here wraps [`asc`](https://github.com/rorkai/App-Store-Connect-CLI),
a Go CLI over the App Store Connect API. `scripts/release.sh` is the repo-specific
glue: it knows our scheme, bundle id, and the fact that `project.yml` leaves
`DEVELOPMENT_TEAM` empty.

Everything below runs on macOS with Xcode installed.

---

## 1. One-time setup

### Install the tools

```bash
brew install asc xcodegen
```

### Create an App Store Connect API key

1. App Store Connect → **Users and Access** → **Integrations** → **App Store Connect API**
2. Create a key with the **App Manager** role (needed to submit for review)
3. Download the `.p8`. **Apple lets you download it exactly once** — store it at
   `~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8`
4. Note the **Key ID** and the **Issuer ID** shown on that page

### Configure the repo

```bash
scripts/setup.sh
```

Prompts for the team id, key id, issuer id and `.p8` path, writes `.asc.env` with
`umask 077`, then checks that the key file exists and the toolchain is installed.
Re-running it offers your current values as defaults. Editing `.asc.env` by hand
works too — `.asc.env.example` documents every field.

`.asc.env` is gitignored, as is `*.p8`. Neither ever gets committed.

Then store the credentials in the keychain and confirm they work:

```bash
scripts/release.sh login
scripts/release.sh doctor
```

`doctor` runs `asc auth doctor`, `asc review doctor`, and lists recent builds —
if something is going to reject a submission, it shows up here first.

### Find the app id

The app must already exist in App Store Connect (bundle id `com.honmaru.ai`).
Create it once in the web UI, then:

```bash
asc apps list --output table
```

Put the numeric id into `ASC_APP_ID` in `.asc.env`.

### Create the distribution certificate and profile

Release builds are signed **manually** (see the `Release` block in
`project.yml`). Automatic signing archives with a *development* identity, and a
development profile cannot be issued until the team has a registered device — so
an automatic archive is impossible on a Mac with no iPhone plugged in, which is
the whole point of shipping through TestFlight. Manual distribution signing has
no such requirement.

Once per machine. `Team ID` below is the `OU` field of your certificate, not the
id in its common name:

```bash
mkdir -p ~/.honmaru-signing && cd ~/.honmaru-signing && umask 077
openssl genrsa -out dist.key 2048
openssl req -new -key dist.key -out dist.csr -subj "/CN=$(id -F)/C=US"

asc certificates create --certificate-type IOS_DISTRIBUTION --csr dist.csr
```

Take the returned certificate id, then turn it into something the keychain will
accept. macOS cannot read a PKCS#12 written with OpenSSL 3 defaults, hence the
explicit legacy algorithms and the non-empty password:

```bash
asc certificates view --id "$CERT_ID" --output json \
  | python3 -c 'import sys,json,base64;sys.stdout.buffer.write(base64.b64decode(json.load(sys.stdin)["data"]["attributes"]["certificateContent"]))' > dist.cer
openssl x509 -inform DER -in dist.cer -out dist.pem
openssl pkcs12 -export -inkey dist.key -in dist.pem -out dist.p12 \
  -passout pass:CHANGEME -macalg sha1 -keypbe PBE-SHA1-3DES -certpbe PBE-SHA1-3DES
security import dist.p12 -k ~/Library/Keychains/login.keychain-db -P CHANGEME \
  -T /usr/bin/codesign
```

Then the profile, named to match `PROVISIONING_PROFILE_SPECIFIER`:

```bash
asc bundle-ids list --output table        # note the id for com.honmaru.ai
asc profiles create --name "HonmaruAI AppStore" --profile-type IOS_APP_STORE \
  --bundle "$BUNDLE_ID" --certificate "$CERT_ID"
asc profiles download --id "$PROFILE_ID" \
  --output ~/Library/MobileDevice/Provisioning\ Profiles/"$PROFILE_UUID".mobileprovision
```

**Back up `dist.key`.** Without it the certificate is dead weight and has to be
reissued, and an account may hold only three distribution certificates.

---

## 2. Ship a TestFlight build

### The backend goes first, and the order is not optional

The app and the Worker are one product with a version skew problem, and it cuts
both ways:

- **App before Worker.** The current app calls `GET /oauth/github/state`, which
  a Worker that has not been redeployed does not serve. Sign-in dies outright.
- **Worker before app.** A build already on testers' phones posts to
  `/oauth/github/token` with no `state`, which the redeployed Worker refuses
  with 400. *Fresh* sign-in on the old build breaks.

Nobody already signed in is affected either way — session tokens keep working,
and a session now extends every time it is used. So the second is the survivable
one, and the window closes the moment testers update.

```bash
cd worker
# Idempotent: every statement is CREATE … IF NOT EXISTS. Safe to re-run.
npx -y wrangler@4 d1 execute tiktokforwork --remote --file schema.sql
npx wrangler deploy
cd ..
```

Then upload without pausing in between, and tell testers to take the update.

### The upload

```bash
scripts/release.sh build 1.0.0      # xcodegen -> archive -> export ipa
scripts/release.sh testflight       # upload, wait for processing, assign group
```

`build` runs `xcodegen generate` first, so a stale `.xcodeproj` is never what
gets archived.

> **Push notifications are switched off in the client.** `aps-environment` has
> to be in the provisioning profile, and "HonmaruAI AppStore" was issued before
> push existed — an archive carrying that entitlement fails to sign. The server
> side is deployed and idle. Turning it on is
> [docs/push-notifications.md](push-notifications.md), and it needs a reissued
> profile, so it is its own release rather than something to bolt onto this one.

The build number comes from `asc builds next-build-number`, so it never collides
with an already-uploaded build. Version and build number are passed to
`xcodebuild` on the command line — a release never leaves `project.yml` dirty.

Override the tester group with `TESTFLIGHT_GROUP="Beta" scripts/release.sh testflight`.

Tester feedback and crashes, without the browser:

```bash
asc testflight feedback list --app "$ASC_APP_ID" --paginate
asc testflight crashes list --app "$ASC_APP_ID" --sort -createdDate --limit 10
```

---

## 3. Submit for App Store review

```bash
scripts/release.sh all 1.0.0
```

That runs, in order:

| Step | What happens |
|------|--------------|
| `build` | `xcodegen generate` → `xcodebuild archive` → export a signed `.ipa` |
| `upload` | `asc builds upload` |
| `metadata` | `asc metadata apply --dry-run`, then apply after you confirm |
| `submit` | `asc review doctor` + `asc validate`, then `asc publish appstore --submit` |

Each mutating step prints the exact command and asks before running it. Nothing
is submitted to Apple without a `y`.

Run the steps individually when you only need one:

```bash
scripts/release.sh metadata 1.0.0
scripts/release.sh submit 1.0.0
```

### See it without doing it

```bash
scripts/release.sh all 1.0.0 --dry-run
```

Prints every command in the pipeline and executes none of them. Useful the first
time, and useful for checking what changed after a CLI upgrade.

### Skip the prompts

```bash
scripts/release.sh all 1.0.0 --yes
```

For CI. Do not use this from a laptop until you have watched the pipeline run
interactively at least once.

---

## 4. Metadata and screenshots

The first `metadata` run scaffolds the directory:

```bash
scripts/release.sh metadata 1.0.0     # runs `asc metadata init` when ./metadata is absent
```

Edit the generated files (description, keywords, release notes, support URL),
commit them, and re-run. Metadata then lives in git and gets reviewed like code
instead of being retyped into a web form.

Screenshots work the same way — put them under `./screenshots` and
`scripts/release.sh metadata` will run `asc screenshots plan` / `apply` as part
of the step.

Keyword check before submitting:

```bash
asc metadata keywords audit --app "$ASC_APP_ID" --version "1.0.0" \
  --blocked-terms-file ./blocked-terms.txt
```

---

## 5. Track a submission

```bash
scripts/release.sh status                   # review status + version list
asc status --app "$ASC_APP_ID" --watch      # live, until state changes
asc submit cancel --version-id "VERSION_ID" --confirm
```

---

## Driving this with an AI agent

`asc` ships agent skills, which is most of the point of the original article:

```bash
asc install-skills
```

With those installed you can say "upload a build and put it in front of internal
testers" or "check whether 1.0.0 is ready to submit" and the agent picks the
commands. Two habits worth keeping:

- Have the agent run `--dry-run` first and show you the plan.
- Keep `--confirm` steps human-approved. A submission is not cheap to undo.

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `not authenticated` | `scripts/release.sh login` |
| `asc auth doctor` complains about the keychain | On CI, log in with `--bypass-keychain` (the script does this automatically when `CI=true`) |
| `xcodebuild` cannot sign | `DEVELOPMENT_TEAM` is empty in `.asc.env` |
| Provisioning profile errors | The script already passes `-allowProvisioningUpdates`; confirm the bundle id exists with `asc bundle-ids list` |
| Build rejected right after upload | `asc review doctor --app "$ASC_APP_ID"` — usually missing screenshots or export compliance |
| `app icons can't be transparent nor contain an alpha channel` | Re-flatten `AppIcon.png`: `sips -s format jpeg AppIcon.png --out /tmp/i.jpg && sips -s format png /tmp/i.jpg --out AppIcon.png`. Any editor that re-exports with alpha reintroduces this. |

## Before the first App Store submission

TestFlight *internal* testing skips Beta App Review, so `build` + `testflight`
works today. App Store review does not: run the checklist at the end of
[production-release-plan.md](production-release-plan.md#release-checklist)
first. Three of those items fail the submission rather than the build, so they
are easy to miss —

- a reachable **privacy policy URL** set in App Store Connect
  ([privacy-policy.md](privacy-policy.md) is the text);
- `PrivacyInfo.xcprivacy` actually inside the built `.ipa` — check with
  `unzip -l build/*.ipa | grep xcprivacy`, because a manifest that xcodegen put
  in the wrong build phase fails review exactly as if it were absent;
- **account deletion** reachable in the app (Guideline 5.1.1(v)) — it is under
  **You → Delete account**.

D1 also has to be migrated before a build that expects the new tables reaches
anyone:

```bash
cd worker && npx -y wrangler@4 d1 execute tiktokforwork --remote --file schema.sql
```

The CLI's own help is authoritative for flags, and it moves faster than this doc:

```bash
asc --help
asc publish appstore --help
```
