# Main integration and release qualification — 2026-09-19

## Source boundary

- Integration branch: `codex/main-review-integration`, based on main `5382136`.
- Native identity response hotfix cherry-picked as `1c10e0f`.
- Original `codex/app-store-ready` worktree and its recordings were left untouched.
- Main's private team-member references, context sync, reminders and five-language support remain in place. This is not a wholesale deployment of the old release branch.

## Fixed regressions

1. WebSocket upgrade now includes the actual organization in its URL. A join payload alone was too late for Durable Object selection and caused the signed-in “No access” screen.
2. Saved email sessions restore authoritative `userId` and `orgId` from `/me`; temporary failures do not delete valid saved credentials.
3. Replacement sockets and account transitions are generation-guarded. Pending sends are separated by account, organization and backend; failed flushes retain the queue tail.
4. RevenueCat uses the production public SDK key and App Store product IDs. Identity transitions are serialized and stale purchase results cannot grant a replacement account's entitlement.
5. Terms and privacy links stay in first-party paywall UI. Drafts are editable and retained on send failure. Text entry is a visible compose choice.
6. iOS dictation requires on-device recognition; unsupported devices/locales fall back to typing. Camera recording has no audio input. AI drafting requires an explicit choice to send text to OpenAI, with a no-AI alternative.
7. Native privacy declarations and policy source now match the intended new build. The existing published policy still describes the old cloud-speech fallback: publish the updated policy with the new release, not silently treat it as already live.
8. CI checks release configuration and preserves dashboard-managed Worker variables with `--keep-vars`.
9. Profile rows such as Plan now hit-test the whole padded row. UI QA reproduced a tap on the row center doing nothing before `contentShape(Rectangle())` was added.

## Verified so far

| Layer | Result |
|---|---|
| Worker / workerd | 402 tests passed across 72 files |
| Reference relay | 26 tests passed; initial sandbox EPERM was rerun with localhost access |
| Web client | TypeScript + Vite production build passed; 8 tests passed |
| Local browser end-to-end | 27 checks passed, including OTP, invite, team membership and removal; mail provider is a local sink |
| Production, ordinary temporary accounts | Signup, password login, `/me`, native member decoding, native WebSocket join, card echo and reconnect persistence passed |
| Production, two ordinary temporary accounts | Invite/accept, OpenAI route, delivery, approval, relogin and persisted approved state passed |
| Cleanup | Disposable production accounts deleted; two-account script verified revoked sessions |
| Native unit/integration | 63 tests passed on iPhone iOS 26.4 and iPad iOS 18.6 during integration |
| UI | First launch, password-screen navigation, typing, explicit no-AI choice and editable review passed on iPad; expanded final matrix recorded below |

Production tests use generated `@example.invalid` identities, not App Review credentials. Passing production API checks does not prove an uploaded App Store binary contains these changes.

## Final qualification evidence

- Release simulator build succeeded (arm64 and x86_64). On iPhone 16 Pro / iOS 18.6, the installed Release app remained alive after the 12-second startup smoke check. This is not a distribution-signed archive or hardware qualification.
- iPhone 17 Pro / iOS 26.4 UI: first launch, email/password navigation, local editable draft and Plan legal links passed. Result: `/private/tmp/honmaru-integration-ui-fixed-iphone.xcresult`.
- Full iPad unit/integration run passed all 63 tests. The first end-to-end login UI run then reproduced missing persistence/No access with `CODE_SIGNING_ALLOWED=NO`; it is deliberately recorded as a failure, not counted as successful login QA. Simulator login verification must include signing/Keychain entitlements, and the CI command now uses ad-hoc signing.
- A subsequent UI attempt also exposed a test-timing problem: tapping the password option before sheet/keyboard presentation completed left the email-code form open. The test now waits for the option, scrolls the actual form and requires the secure field before entering credentials. Final signed results are recorded below after completion.

### Reproduction

```sh
node scripts/verify-review-config.mjs
# Select an installed simulator UUID explicitly; use a new result path per run.
HONMARU_LIVE_AUTH_TEST=1 xcodebuild test \
  -project TikTokForWork.xcodeproj -scheme TikTokForWork \
  -destination 'platform=iOS Simulator,id=<SIMULATOR_UUID>' \
  CODE_SIGNING_ALLOWED=YES CODE_SIGN_IDENTITY=-
```

`HONMARU_LIVE_AUTH_TEST=1` opts into creating and deleting ordinary temporary accounts on the configured production backend; omit it for offline CI. Do not use real user or reviewer credentials in test logs.

## Release gate — not yet a submission approval

- Build a signed archive from this integrated source, record its commit/build number, and verify the uploaded binary is the selected App Store version.
- Recheck physical-device dictation, permission denial, silent video, purchase/restore, push delivery and account deletion using that exact build. Simulator UI tests do not qualify microphone hardware, APNs delivery or real StoreKit purchase behavior.
- iOS 17 and the reported reviewer environment (iPad Air 11 M3 / iPadOS 27.0) are not installed here. Tested runtimes must not be described as “all versions and devices.”
- Update the public privacy page and App Store privacy answers together with the build. Review Apple’s on-device-only collection definition before removing Audio Data from the store questionnaire.
- Attach a physical-device recording of launch → login → normal team flow → optional dictation/edited text → purchase information → account deletion, as Apple requested. Do not pass off simulator footage as physical-device footage.
- Update App Review Notes and the resolution response only with confirmed build-specific facts. No new App Store submission was performed as part of these local tests.

## Draft reply for the newly uploaded build (fill verified build/video before sending)

“We corrected the workspace connection issue: the native client now selects the authenticated workspace during the WebSocket upgrade and restores membership from the server. We verified ordinary account login, workspace loading, card delivery and reconnect persistence.

In the new build, microphone audio is used only for on-device transcription via Apple's Speech framework. On-device recognition is required; if unavailable, the app offers typed input and does not fall back to server speech recognition. Raw microphone audio is not uploaded to Honmaru AI, OpenAI, Apple speech servers or teammates. Optional recorded video is silent. The user may explicitly choose to send the reviewed text and necessary work context to OpenAI for drafting, or continue without AI. Cards are reviewed before team delivery.

Build: [verified uploaded build]. Physical-device recording: [accessible video URL].”

## References

- [Apple review guidelines — privacy and third-party AI](https://developer.apple.com/jp/app-store/review/guidelines/)
- [Apple App Privacy Details](https://developer.apple.com/app-store/app-privacy-details/)
- [Wrangler command reference](https://developers.cloudflare.com/workers/wrangler/commands/)
