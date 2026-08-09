# Appearance Toggle + Video Capture — Design

Date: 2026-08-09
Status: Approved design, pre-implementation
Sub-project 1 of the feature-development phase (chosen order: small UX wins first).

## Goal

Two independent iOS UX wins that ship fast and change the daily experience:

- **D — Appearance toggle:** an in-app System / Light / Dark control, with a real
  dark theme (today the app is light-only and follows the system, which is
  confusing).
- **E — Video capture:** restore the TikTok-style capture the app was named for —
  press `+`, record a video of yourself talking, on-device speech-to-text becomes
  the instruction, the AI routes it, and the Decision Card carries the video so
  the recipient watches you to decide. (This intentionally re-introduces the
  camera/video stack that Phase 4C removed as scope-creep — the product vision
  now makes it core.)

The other four workstreams (multi-connector, backend DB/history, the "Coming
soon" settings screens) are separate sub-projects, brainstormed later.

## D — Appearance toggle

### Problem

`TikTokForWork/Design/Theme.swift` defines colors as hardcoded light hex
(`Color(hex: 0xFFFFFF)`, …). `.preferredColorScheme(.dark)` alone does nothing to
hardcoded hex, so a real dark mode needs the palette itself to adapt.

### Approach

1. **Make `Theme.Colors` adaptive.** Back each semantic color with a dynamic
   `UIColor` that resolves per `userInterfaceStyle`:
   ```swift
   static func dyn(_ light: UInt, _ dark: UInt) -> Color {
       Color(uiColor: UIColor { $0.userInterfaceStyle == .dark ? UIColor(hex: dark) : UIColor(hex: light) })
   }
   static let background = dyn(0xFFFFFF, 0x0E0E10)
   ```
   Every call site (`Theme.Colors.background`, …) is unchanged; only the
   definitions change.
2. **Dark palette** derived from the light "white marble" system:
   | token | light | dark |
   |-------|-------|------|
   | background | `FFFFFF` | `0E0E10` |
   | surface | `F8F9FA` | `18181B` |
   | surfaceRaised | `EEEEEE` | `242428` |
   | textPrimary | `202020` | `EDEDED` |
   | textSecondary | `646464` | `A0A0A8` |
   | textTertiary | `838383` | `6E6E76` |
   | border | `E8E8E8` | `2E2E33` |
   | ctaFill | `202020` | `EDEDED` (dark CTA on light text) |
   | accent | `6647F0` | `8A6EFF` (lifted for contrast) |
   | interactive | `0091FF` | `3AA9FF` |
   | approve | `00C07A` | `2BD69A` |
   | issueGreen | `238636` | `3FB950` |
   | reject | `FA49A5` | `FF6FB8` |
   (Final dark values may be nudged during implementation for contrast; the light
   column must stay byte-identical so light mode is unchanged.)
3. **Setting.** `AppState` gains `@Published var appearance: AppAppearance`
   (`system` / `light` / `dark`), persisted in `UserDefaults` (mirrors the
   `language` setting). A new `AppAppearance` enum exposes
   `colorScheme: ColorScheme?` (nil for system).
4. **Apply** at the root: `.preferredColorScheme(appState.appearance.colorScheme)`
   on `RootView` in `TikTokForWorkApp`, next to the existing `.environment(\.locale, …)`.
5. **UI.** A picker in `YouView`, directly beside the Language picker
   (`System / Light / Dark`), bound to `$appState.appearance`.

### Out of scope for D

Per-screen theming, custom accent selection, scheduled/auto dark. Just the toggle
+ a correct dark palette.

## E — Video capture → transcribe → route

### Flow

`+` → `CaptureView` (full-screen camera) → record video while speaking → stop →
on-device speech-to-text yields the instruction text + the recorded video file →
the text goes to `/ai/route` exactly as today → the created Decision Card carries
the uploaded video URL → the recipient's card plays the video (AVPlayer). A
text-only path stays available (type instead of record).

### iOS (restore + adapt)

Restore these 7 files from the Phase-4C deletion commit `74f5eec` (they were
removed cleanly, so restore then adapt):
`Features/Shell/CaptureView.swift`, `Features/Shell/CameraViewfinder.swift`,
`Services/VideoRecorder.swift`, `Services/DictationService.swift`,
`Services/MediaUploader.swift`, `Services/MediaStore.swift`,
`Features/Feed/CardVideoView.swift`, and `Models/CaptureRequest.swift`.

Adaptations:
- **`MediaUploader`** posts to the deployed Worker `POST {backendBaseURL}/media`
  (was the localhost relay). Returns `{ url }`.
- **`DecisionCard.videoURL: String?`** is re-added (removed in 4C), threaded
  through `DecisionCardService.processRouting(..., videoURL:)` and the card
  `dictionary` encode/decode.
- **`FeedViewModel.beginDraft(..., videoURL:)`** re-added; the transcript is the
  instruction text, `videoURL` is the uploaded URL.
- **`+` button** in `AppShell` reopens `CaptureView` (Phase 4C had repointed it to
  the text sheet). The text AI-input sheet remains reachable (e.g. a "type
  instead" affordance in `CaptureView`, as before).
- **`CardVideoView`** plays `card.videoURL` via AVPlayer, streamed from R2.
- Info.plist camera/mic/speech usage strings (removed in 4C) are re-added:
  `NSCameraUsageDescription`, `NSMicrophoneUsageDescription`,
  `NSSpeechRecognitionUsageDescription`.

### Backend — media on Cloudflare R2

The old `server/media.js` (disk-backed `/media`) was never ported. Add an R2
bucket to the Worker:
- `wrangler.toml`: `[[r2_buckets]] binding = "MEDIA", bucket_name = "tiktokforwork-media"`.
- `worker/src/media.js`: `POST /media` reads the request body (the video bytes),
  generates an id, `env.MEDIA.put(id, body, { httpMetadata: { contentType } })`,
  returns `{ url: "{origin}/media/{id}" }`. `GET /media/:id` → `env.MEDIA.get(id)`
  streamed back with its content type (404 if absent).
- Wire both routes into `worker/src/index.js` before the WS-upgrade block.
- Auth: require the `x-session-token` header (reuse `getSession`) so only
  signed-in users upload; guests can't attach video (they have no session).

### Data flow

```
+ → record (video file) + dictation (text)
  → MediaUploader.upload(video) → POST /media (R2) → url
  → AIService.draftInstruction(text, …) → /ai/route → routing
  → card {..., videoURL: url} → relay (card_created) → recipient
  → recipient taps card → CardVideoView(AVPlayer, url) → GET /media/:id (R2)
```

### Out of scope for E

Server-side transcription (on-device only), video editing/filters, thumbnails,
transcoding, and video for the guest (no-session) path.

## Implementation order

1. **D — appearance** (self-contained; ship first).
2. **E-backend** — R2 bucket + `/media` routes on the Worker; deploy.
3. **E-iOS** — restore + adapt the 7 files; `videoURL` on the card; wire `+`.

## Testing / verification

- **D:** build; simulator screenshots in light and dark; confirm light mode is
  visually unchanged and dark renders across feed/onboarding/settings.
- **E-backend:** `worker` vitest for `POST /media` + `GET /media/:id` using the
  vitest-pool-workers R2 binding (a real in-memory R2), plus an auth-required
  (401) case; deploy smoke (`curl` upload + fetch round-trip).
- **E-iOS:** build (`xcodebuild`). The camera/dictation flow needs a **real
  device** (the simulator has no camera and the earlier HTTP/3 caveat); the
  simulator verifies compile + non-camera UI. Full capture→route→playback is a
  device/TestFlight check.

## Success criteria

- Settings shows Appearance (System/Light/Dark) beside Language; switching to Dark
  renders a correct dark theme app-wide, live; Light is unchanged.
- On a device: `+` opens the camera; recording while speaking produces a routed
  Decision Card whose transcript drove the routing and whose video plays back for
  the recipient from R2.
