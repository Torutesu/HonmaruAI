# Phase 6: Ship to TestFlight — Runbook

> Operational runbook (not a TDD plan). The release pipeline already exists as
> `scripts/release.sh` (an `asc` App-Store-Connect-CLI wrapper) and has shipped
> builds 12–22. Phase 6 archives the current code (Phases 1–5) and pushes a new
> build to TestFlight.

**Goal:** A new TestFlight build carrying the real-product code (deployed Cloudflare backend, GitHub identity, real org, OpenAI routing, scope-trimmed UI, language toggle) so testers can run the real end-to-end flow on device.

## Readiness (verified via `scripts/release.sh doctor`)

- `asc` CLI 3.5.1 installed; auth profile `HonmaruAI` validates ("works").
- App id `6799302006` (`com.honmaru.ai`); builds 12–22 already uploaded, VALID.
- Signing: "iPhone Distribution: toru tano" cert present; Release config uses Manual signing + profile "HonmaruAI AppStore"; `-allowProvisioningUpdates` lets Xcode refresh via the ASC key.
- `.asc.env` has ASC_KEY_ID / ASC_ISSUER_ID / ASC_PRIVATE_KEY (.p8 present) / ASC_APP_ID / DEVELOPMENT_TEAM.
- **TestFlight vs App Store:** `review doctor` reports 34 blockers (age rating, screenshots, description, availability, …). Those gate **App Store submission**, NOT TestFlight internal testing. Phase 6 does **build + testflight only** — no `submit`.

## Steps

1. **Confirm a clean, committed tree** (release builds the generated project from the current files):
   `git status --short` → clean.

2. **Build the archive + IPA** (Release, signed). Marketing version stays `1.0`; the build number is auto-fetched as the next unused (→ 23):
   ```
   ./scripts/release.sh build 1.0
   ```
   Produces `build/export/*.ipa`. Takes several minutes (Release archive).

3. **Publish to TestFlight** (upload + processing wait + assign to the tester group). Non-interactive, so pass `--yes`:
   ```
   ./scripts/release.sh testflight --yes
   ```
   (Uses group `Internal Testers` by default; `asc publish testflight … --wait` blocks until Apple finishes processing or reports an ITMS rejection.)

4. **Verify** the new build appears:
   ```
   ./scripts/release.sh status
   asc builds list --app 6799302006 --output table
   ```
   Expect build 23, version 1.0, Processing → VALID.

## After shipping

- Testers install via TestFlight and run the **real end-to-end flow on a device** (the iOS Simulator can't reach the Cloudflare HTTP/3 endpoint via URLSession): GitHub sign-in → repo pick → real org → tell your AI → card routed to a real teammate → decide → reflects back.
- App Store *submission* (the 34 `review doctor` items: age rating, screenshots, description, categories, availability, copyright, privacy policy) is a separate, later effort — out of scope for TestFlight.
