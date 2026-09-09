# Voice/text capture and team setup

Source: `527462a3949d9dbba4f5ccd7075d494196ed8faf`.

- iOS and Web start with Speak / Write, then prepare an editable card.
- Recipient selection is deferred to review and remains required before sending.
- Type, priority, title, summary, and context edits sit behind Edit details.
- iOS entry points no longer offer video capture.
- Team settings expose members, invite creation, and invite redemption.
- Team switching keeps an unsent draft and clears the selected recipient.
- No actual membership was granted as part of this UI change.

## Verification

- iOS RequestComposerTests: 6 passed, including no-team review and team-switch draft retention.
- Web unit tests: 23 passed; production TypeScript/Vite build passed.
- Worker tests: 353 passed.
- Local browser: Japanese voice/text entry and recipient-free preview exercised in sample mode; send remained disabled without a recipient. Dark preview visually checked.
- Release simulator launch passed, with process alive after the 12-second check and no fatal log signature.
- Signed build 34 / version 1.0: application identifier `BAF4U6PT5S.com.honmaru.ai`, APNs entitlement `production`.
- IPA SHA-256: `9977cacbbbd4f1eed52ac5a215f75ab64d1dd1e6c6017bbbfce1f4282c0d07e9`.

## Published services

- Web deployment: https://3c234ab8.honmaru-web.pages.dev
- Production: https://honmaru-web.pages.dev
- Public HTML points to the verified build's `index-CT2RN7kn.js` and `index-DMbyCHoH.css`.
- Worker version: `f83504dd-2937-4e91-850d-96cf6649c6d4`.
- `/members` previously returned 404. After deployment, an unauthenticated request returns 401 (`invalid session`). Necessary users/memberships columns were verified without DB changes.
- `/health` retains `push: true`, `webPush: true`, `email: true`.

## Limits

Real microphone recognition, authenticated invite/join across two users, and physical iPhone notification delivery have not been re-qualified. Browser/native UI access later timed out, so production screen interaction was not re-verified after the public-file checks. Sample/browser and simulator results do not prove those external flows.
