# App Store release with `asc`

Ship TikTok for Work — TestFlight builds and App Store review submissions — from
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
cp .asc.env.example .asc.env
$EDITOR .asc.env          # fill in key id, issuer id, key path, team id
```

`.asc.env` is gitignored, as is `*.p8`. Neither ever gets committed.

Then store the credentials in the keychain and confirm they work:

```bash
scripts/release.sh login
scripts/release.sh doctor
```

`doctor` runs `asc auth doctor`, `asc review doctor`, and lists recent builds —
if something is going to reject a submission, it shows up here first.

### Find the app id

The app must already exist in App Store Connect (bundle id `com.tangle.tiktokforwork`).
Create it once in the web UI, then:

```bash
asc apps list --output table
```

Put the numeric id into `ASC_APP_ID` in `.asc.env`.

---

## 2. Ship a TestFlight build

This is the unchecked item in `PROGRESS.md`.

```bash
scripts/release.sh build 1.0.0      # xcodegen -> archive -> export ipa
scripts/release.sh testflight       # upload, wait for processing, assign group
```

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

The CLI's own help is authoritative for flags, and it moves faster than this doc:

```bash
asc --help
asc publish appstore --help
```
