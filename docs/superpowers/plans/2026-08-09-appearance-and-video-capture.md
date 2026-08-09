# Appearance Toggle + Video Capture Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an in-app System/Light/Dark appearance toggle with a real dark theme, and restore the TikTok-style capture flow (record yourself talking → on-device transcript routes the instruction → the Decision Card carries the video, stored in Cloudflare R2).

**Architecture:** `Theme.Colors` becomes adaptive (dynamic `UIColor` resolving per interface style) so every existing call site gets dark for free; an `AppAppearance` setting in `AppState` drives `.preferredColorScheme` at the root. For video, the Worker gains an R2-backed `POST /media` + `GET /media/:id` (session-authenticated), and the iOS capture stack deleted in Phase 4C is restored from commit `74f5eec^` and repointed at the hosted Worker.

**Tech Stack:** SwiftUI, AVFoundation + Speech (on-device), xcodegen/xcodebuild; Cloudflare Workers + R2, Vitest + `@cloudflare/vitest-pool-workers`.

## Verification model

- **iOS:** no test target — a task is verified by
  `cd /Users/torutano/HonmaruAI && xcodegen generate && xcodebuild -project TikTokForWork.xcodeproj -scheme TikTokForWork -destination 'generic/platform=iOS Simulator' -configuration Debug build 2>&1 | tail -6` ending in `** BUILD SUCCEEDED **`, plus simulator screenshots where the change is visual.
- **Worker:** `cd /Users/torutano/HonmaruAI/worker && npm test` (currently 27 tests) must stay green and gain the new media tests.

## File Structure

```
TikTokForWork/
  Design/Theme.swift          # adaptive colors (light values unchanged)
  App/AppAppearance.swift     # NEW: system/light/dark enum
  App/AppState.swift          # + appearance setting (mirrors `language`)
  TikTokForWorkApp.swift      # + .preferredColorScheme
  Features/Shell/YouView.swift# + Appearance picker beside Language
  Features/Shell/CaptureView.swift, CameraViewfinder.swift   # restored
  Services/VideoRecorder.swift, DictationService.swift,
           MediaUploader.swift, MediaStore.swift             # restored
  Features/Feed/CardVideoView.swift                          # restored
  Models/CaptureRequest.swift                                # restored
  Models/DecisionCard.swift   # + videoURL
  Services/DecisionCardService.swift, ViewModels/FeedViewModel.swift  # thread videoURL
  Features/Shell/AppShell.swift  # + reopens CaptureView
  Info.plist                  # + camera/mic/speech usage strings
worker/
  src/media.js                # NEW: R2 upload/serve
  src/index.js                # + /media routes
  wrangler.toml               # + R2 binding
  test/media.test.js          # NEW
```

---

# Part D — Appearance toggle

## Task 1: Adaptive theme colors

**Files:**
- Modify: `TikTokForWork/Design/Theme.swift`

- [ ] **Step 1: Add a dynamic-color helper and dark values**

Replace the `enum Colors { … }` block (currently 13 `Color(hex:)` constants) with adaptive definitions. Keep the light hex values byte-identical so light mode cannot change:

```swift
    enum Colors {
        /// Resolves per interface style, so every call site gets dark for free.
        private static func dyn(_ light: UInt, _ dark: UInt) -> Color {
            Color(uiColor: UIColor { traits in
                UIColor(hex: traits.userInterfaceStyle == .dark ? dark : light)
            })
        }

        static let background = dyn(0xFFFFFF, 0x0E0E10)
        static let surface = dyn(0xF8F9FA, 0x18181B)
        static let surfaceRaised = dyn(0xEEEEEE, 0x242428)
        static let textPrimary = dyn(0x202020, 0xEDEDED)
        static let textSecondary = dyn(0x646464, 0xA0A0A8)
        static let textTertiary = dyn(0x838383, 0x6E6E76)
        static let accent = dyn(0x6647F0, 0x8A6EFF)
        static let interactive = dyn(0x0091FF, 0x3AA9FF)
        static let approve = dyn(0x00C07A, 0x2BD69A)
        static let issueGreen = dyn(0x238636, 0x3FB950)
        static let reject = dyn(0xFA49A5, 0xFF6FB8)
        static let border = dyn(0xE8E8E8, 0x2E2E33)
        static let ctaFill = dyn(0x202020, 0xEDEDED)
    }
```

- [ ] **Step 2: Add the `UIColor(hex:)` initializer**

`Theme.swift` already has `extension Color { init(hex:opacity:) }` — keep it (other code may use it). Add a UIKit twin next to it, since `dyn` needs `UIColor`:

```swift
extension UIColor {
    convenience init(hex: UInt, alpha: CGFloat = 1) {
        self.init(
            red: CGFloat((hex >> 16) & 0xFF) / 255,
            green: CGFloat((hex >> 8) & 0xFF) / 255,
            blue: CGFloat(hex & 0xFF) / 255,
            alpha: alpha
        )
    }
}
```

Add `import UIKit` at the top of `Theme.swift` if `import SwiftUI` alone does not expose `UIColor` (on iOS it does via UIKit re-export, but be explicit).

- [ ] **Step 3: Build**

Run the iOS build command from the Verification model.
Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Commit**

```bash
git add TikTokForWork/Design/Theme.swift
git commit -m "feat(ios): adaptive theme colors with a dark palette"
```

---

## Task 2: Appearance setting + root application + picker

**Files:**
- Create: `TikTokForWork/App/AppAppearance.swift`
- Modify: `TikTokForWork/App/AppState.swift`, `TikTokForWork/TikTokForWorkApp.swift`, `TikTokForWork/Features/Shell/YouView.swift`

- [ ] **Step 1: Create `TikTokForWork/App/AppAppearance.swift`**

```swift
import SwiftUI

/// The user's appearance choice. `.system` follows the device.
enum AppAppearance: String, CaseIterable, Identifiable {
    case system
    case light
    case dark

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return String(localized: "System")
        case .light: return String(localized: "Light")
        case .dark: return String(localized: "Dark")
        }
    }

    /// nil means "follow the system".
    var colorScheme: ColorScheme? {
        switch self {
        case .system: return nil
        case .light: return .light
        case .dark: return .dark
        }
    }
}
```

- [ ] **Step 2: Add the setting to `AppState`**

Mirror the existing `language` property exactly (it is `@Published` with a `didSet` that persists). Add next to it:

```swift
    @Published var appearance: AppAppearance = {
        AppAppearance(rawValue: UserDefaults.standard.string(forKey: "appAppearance") ?? "system") ?? .system
    }() {
        didSet { UserDefaults.standard.set(appearance.rawValue, forKey: "appAppearance") }
    }
```

- [ ] **Step 3: Apply at the root**

In `TikTokForWorkApp.swift`, the body currently chains `.environmentObject(appState)` and `.environment(\.locale, …)` on `RootView()`. Add one more modifier:

```swift
                .preferredColorScheme(appState.appearance.colorScheme)
```

- [ ] **Step 4: Add the picker to `YouView`**

`YouView` already has a `.menu`-style `Picker` bound to `$appState.language` (added in Phase 5). Add an identical one for appearance directly beside it, matching its padding:

```swift
        Picker(selection: $appState.appearance) {
            ForEach(AppAppearance.allCases) { mode in
                Text(mode.label).tag(mode)
            }
        } label: {
            Text("Appearance")
        }
        .pickerStyle(.menu)
```

- [ ] **Step 5: Add Japanese translations to the catalog**

Open `TikTokForWork/Localizable.xcstrings` and add `ja` entries for the new keys if absent — `"Appearance"` → `"外観"`, `"Light"` → `"ライト"`, `"Dark"` → `"ダーク"`. (`"System"` already exists from the language work; do not duplicate it — search first.) Entries take the same shape as existing ones:

```json
    "Appearance" : {
      "localizations" : {
        "ja" : { "stringUnit" : { "state" : "translated", "value" : "外観" } }
      }
    },
```

Validate: `python3 -c "import json;json.load(open('TikTokForWork/Localizable.xcstrings'));print('valid json')"` → must print `valid json`.

- [ ] **Step 6: Build**

Run the iOS build command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 7: Simulator screenshots — light vs dark**

```bash
DEV=$(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}' | head -1)
APP=$(find ~/Library/Developer/Xcode/DerivedData/TikTokForWork-*/Build/Products/Debug-iphonesimulator -maxdepth 1 -name "TikTokForWork.app" | head -1)
xcrun simctl install "$DEV" "$APP"
# light
xcrun simctl ui "$DEV" appearance light
xcrun simctl launch "$DEV" com.honmaru.ai -RelayURL "ws://127.0.0.1:9999"
sleep 5 && xcrun simctl io "$DEV" screenshot /tmp/appearance_light.png
# dark (system-follow proves the adaptive palette works end to end)
xcrun simctl terminate "$DEV" com.honmaru.ai
xcrun simctl ui "$DEV" appearance dark
xcrun simctl launch "$DEV" com.honmaru.ai -RelayURL "ws://127.0.0.1:9999"
sleep 5 && xcrun simctl io "$DEV" screenshot /tmp/appearance_dark.png
```
Expected: the light shot is unchanged from before this work; the dark shot shows a dark canvas with readable text. Report both. (The dead relay URL keeps the UI reachable without the backend.)

- [ ] **Step 8: Commit**

```bash
git add TikTokForWork/App/AppAppearance.swift TikTokForWork/App/AppState.swift TikTokForWork/TikTokForWorkApp.swift TikTokForWork/Features/Shell/YouView.swift TikTokForWork/Localizable.xcstrings
git commit -m "feat(ios): appearance toggle (System / Light / Dark)"
```

---

# Part E — Video capture

## Task 3: R2 media endpoints on the Worker

**Files:**
- Create: `worker/src/media.js`, `worker/test/media.test.js`
- Modify: `worker/wrangler.toml`, `worker/src/index.js`, `worker/vitest.config.js`

- [ ] **Step 1: Add the R2 binding to `worker/wrangler.toml`**

Append:

```toml
[[r2_buckets]]
binding = "MEDIA"
bucket_name = "tiktokforwork-media"
```

- [ ] **Step 2: Add the R2 test binding to `worker/vitest.config.js`**

The `miniflare` block currently has `compatibilityFlags` and `d1Databases`. Add:

```js
          r2Buckets: ["MEDIA"],
```

- [ ] **Step 3: Write the failing test `worker/test/media.test.js`**

```js
import { SELF, env } from "cloudflare:test";
import { beforeAll, expect, test } from "vitest";
import schemaSql from "../schema.sql?raw";
import { createSession } from "../src/db.js";

let token;
beforeAll(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g, " "));
  token = await createSession(env.DB, "77", "gho_media");
});

test("POST /media stores the body and GET /media/:id returns it", async () => {
  const bytes = new Uint8Array([0, 1, 2, 3, 4, 5]);
  const up = await SELF.fetch("https://example.com/media", {
    method: "POST",
    headers: { "x-session-token": token, "content-type": "video/mp4" },
    body: bytes,
  });
  expect(up.status).toBe(200);
  const { id, url } = await up.json();
  expect(typeof id).toBe("string");
  expect(url).toContain(`/media/${id}`);

  const down = await SELF.fetch(`https://example.com/media/${id}`);
  expect(down.status).toBe(200);
  expect(down.headers.get("content-type")).toBe("video/mp4");
  expect(new Uint8Array(await down.arrayBuffer())).toEqual(bytes);
});

test("POST /media requires a session", async () => {
  const res = await SELF.fetch("https://example.com/media", {
    method: "POST",
    headers: { "content-type": "video/mp4" },
    body: new Uint8Array([1]),
  });
  expect(res.status).toBe(401);
});

test("GET /media/:id is 404 for an unknown id", async () => {
  const res = await SELF.fetch("https://example.com/media/does-not-exist");
  expect(res.status).toBe(404);
});
```

- [ ] **Step 4: Run to verify it fails**

Run: `cd worker && npm test -- media.test.js`
Expected: FAIL — the routes 404 (not implemented).

- [ ] **Step 5: Create `worker/src/media.js`**

```js
// Video attached to a decision card, stored in R2.
//
// Deliberately dumb: bytes land under a random id and are served back by that
// id. There is no database row — a card already carries the only reference that
// matters, and losing the object should degrade to a card without video rather
// than a card that cannot load.

const MAX_BYTES = 40 * 1024 * 1024;

export async function uploadMedia(request, env, url) {
  const contentType = request.headers.get("content-type") || "video/mp4";
  const length = Number(request.headers.get("content-length") || 0);
  if (length > MAX_BYTES) {
    return new Response(JSON.stringify({ message: `Video is larger than ${MAX_BYTES} bytes.` }), {
      status: 413,
      headers: { "content-type": "application/json" },
    });
  }
  const id = crypto.randomUUID();
  await env.MEDIA.put(id, request.body, { httpMetadata: { contentType } });
  return new Response(JSON.stringify({ id, url: `${url.origin}/media/${id}` }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

export async function serveMedia(id, env) {
  const object = await env.MEDIA.get(id);
  if (!object) return new Response("not found", { status: 404 });
  return new Response(object.body, {
    status: 200,
    headers: {
      "content-type": object.httpMetadata?.contentType || "video/mp4",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
}
```

- [ ] **Step 6: Wire the routes into `worker/src/index.js`**

Add the import beside the existing ones:

```js
import { uploadMedia, serveMedia } from "./media.js";
```

Add inside `fetch`, before the WebSocket-upgrade block (the org-graph route is already there; put these next to it):

```js
    if (url.pathname === "/media" && request.method === "POST") {
      const session = await getSession(env.DB, request.headers.get("x-session-token"));
      if (!session) return json({ message: "invalid session" }, 401);
      return uploadMedia(request, env, url);
    }
    const mediaMatch = url.pathname.match(/^\/media\/([^/]+)$/);
    if (mediaMatch && request.method === "GET") {
      return serveMedia(mediaMatch[1], env);
    }
```

(`getSession` and `json` are already imported/defined in this file.)

- [ ] **Step 7: Run the media tests, then the full suite**

Run: `cd worker && npm test -- media.test.js`
Expected: PASS (3 tests).
Run: `cd worker && npm test`
Expected: PASS (27 prior + 3 = 30). Paste output.

- [ ] **Step 8: Commit**

```bash
git add worker/src/media.js worker/src/index.js worker/wrangler.toml worker/vitest.config.js worker/test/media.test.js
git commit -m "feat(worker): R2-backed media upload and playback"
```

---

## Task 4: Create the R2 bucket and deploy

**Files:** none (operational)

- [ ] **Step 1: Create the bucket**

Run: `cd worker && npx wrangler r2 bucket create tiktokforwork-media`
Expected: "Created bucket tiktokforwork-media". (If it already exists, wrangler says so — fine, continue.)

- [ ] **Step 2: Deploy**

Run: `cd worker && npx wrangler deploy`
Expected: prints a new Version ID and the bindings list now includes `MEDIA` (R2).

- [ ] **Step 3: Smoke-test unauthenticated upload is rejected**

Run:
```bash
curl -s -o /dev/null -w "%{http_code}\n" -X POST \
  -H 'content-type: video/mp4' --data-binary 'x' \
  https://tiktokforwork.torubj0904.workers.dev/media
```
Expected: `401`.

- [ ] **Step 4: Smoke-test an unknown id 404s**

Run: `curl -s -o /dev/null -w "%{http_code}\n" https://tiktokforwork.torubj0904.workers.dev/media/nope`
Expected: `404`.

(A full authenticated upload needs a real session token, which comes from GitHub OAuth on a device — it is covered by the device check at the end of Task 7.)

- [ ] **Step 5: Commit any config drift**

```bash
git add worker/wrangler.toml
git commit -m "chore(worker): provision the media R2 bucket" || echo "nothing to commit"
```

---

## Task 5: Restore the iOS capture stack

**Files:**
- Restore from `74f5eec^`: `TikTokForWork/Features/Shell/CaptureView.swift`, `TikTokForWork/Features/Shell/CameraViewfinder.swift`, `TikTokForWork/Services/VideoRecorder.swift`, `TikTokForWork/Services/DictationService.swift`, `TikTokForWork/Services/MediaUploader.swift`, `TikTokForWork/Services/MediaStore.swift`, `TikTokForWork/Features/Feed/CardVideoView.swift`, `TikTokForWork/Models/CaptureRequest.swift`
- Modify: `TikTokForWork/Info.plist`

- [ ] **Step 1: Restore the eight files**

```bash
cd /Users/torutano/HonmaruAI
git checkout 74f5eec^ -- \
  TikTokForWork/Features/Shell/CaptureView.swift \
  TikTokForWork/Features/Shell/CameraViewfinder.swift \
  TikTokForWork/Services/VideoRecorder.swift \
  TikTokForWork/Services/DictationService.swift \
  TikTokForWork/Services/MediaUploader.swift \
  TikTokForWork/Services/MediaStore.swift \
  TikTokForWork/Features/Feed/CardVideoView.swift \
  TikTokForWork/Models/CaptureRequest.swift
```

- [ ] **Step 2: Re-add the privacy usage strings to `TikTokForWork/Info.plist`**

Inside the top-level `<dict>`, add:

```xml
	<key>NSCameraUsageDescription</key>
	<string>Record a short video so your teammate can see what you mean.</string>
	<key>NSMicrophoneUsageDescription</key>
	<string>Record what you say so your AI can turn it into a decision.</string>
	<key>NSSpeechRecognitionUsageDescription</key>
	<string>Turn what you say into the instruction your AI routes.</string>
```

- [ ] **Step 3: Localize the restored Japanese literals in `CaptureView.swift`**

The restored file predates Phase 5 and contains hardcoded Japanese (`"閉じる"`, `"録音中"`, `"聞き取り中"`, `"話しかけてください…"`, `"話す · 直せる · 送ると AI が宛先を決めます"`, `"録音を止める"`, `"録音する"`). Replace each with the English key so the language toggle works:
`"閉じる"`→`"Close"`, `"録音中"`→`"Recording"`, `"聞き取り中"`→`"Listening"`, `"話しかけてください…"`→`"Speak now…"`, the help line→`"Speak · edit · send, and your AI picks the recipient"`, `"録音を止める"`→`"Stop recording"`, `"録音する"`→`"Record"`.
Then add any of these keys that are missing to `TikTokForWork/Localizable.xcstrings` with the original Japanese as the `ja` value (same JSON shape as Task 2 Step 5; `"Close"` already exists — search before adding). Validate the JSON with the same `python3 -c` command.

- [ ] **Step 4: Build**

Run the iOS build command.
Expected: `** BUILD SUCCEEDED **`. The restored files may reference things Phase 4C changed — most likely `CardVideoView` referencing `card.videoURL` (added in Task 6) and `CaptureView`'s send closure. If the build fails ONLY because `videoURL` does not exist yet, proceed to Task 6 and build there instead; note it in the report. Fix any other compile error here.

- [ ] **Step 5: Commit**

```bash
git add TikTokForWork/Features/Shell/CaptureView.swift TikTokForWork/Features/Shell/CameraViewfinder.swift TikTokForWork/Services/VideoRecorder.swift TikTokForWork/Services/DictationService.swift TikTokForWork/Services/MediaUploader.swift TikTokForWork/Services/MediaStore.swift TikTokForWork/Features/Feed/CardVideoView.swift TikTokForWork/Models/CaptureRequest.swift TikTokForWork/Info.plist TikTokForWork/Localizable.xcstrings
git commit -m "feat(ios): restore the capture stack (camera, dictation, media)"
```

---

## Task 6: Carry the video on the card

**Files:**
- Modify: `TikTokForWork/Models/DecisionCard.swift`, `TikTokForWork/Services/DecisionCardService.swift`, `TikTokForWork/ViewModels/FeedViewModel.swift`, `TikTokForWork/Features/Feed/DecisionCardView.swift`

- [ ] **Step 1: Re-add `videoURL` to the card model**

In `TikTokForWork/Models/DecisionCard.swift`, add the stored property next to the other optionals:

```swift
    var videoURL: String?
```

`DecisionCard` is `Codable` with synthesized keys, so decoding older payloads (no `videoURL`) still works. If the file has an explicit `dictionary` (wire encoding) helper, add the field there too:

```swift
        if let videoURL { dict["videoURL"] = videoURL }
```
(Read the `dictionary` property and match its existing style; if it builds the dict from every field explicitly, add this line alongside the other optionals.)

- [ ] **Step 2: Thread `videoURL` through card creation**

In `TikTokForWork/Services/DecisionCardService.swift`, restore the parameter on the routing-to-card method (Phase 4C removed it). Find `processRouting(` and add a trailing parameter, defaulting to nil so other call sites are unaffected:

```swift
        videoURL: String? = nil,
```
and set it on the card it constructs:
```swift
            videoURL: videoURL,
```

- [ ] **Step 3: Thread `videoURL` through the feed view model**

In `TikTokForWork/ViewModels/FeedViewModel.swift`, re-add the pending-video plumbing:

```swift
    private var pendingVideoURL: String?
```
Add a `videoURL: String? = nil` parameter to `beginDraft(_:priority:appState:)` and store it (`pendingVideoURL = videoURL`) at the top, then pass `videoURL: pendingVideoURL` into the `processRouting(...)` call, and clear it (`pendingVideoURL = nil`) after the card is created.

- [ ] **Step 4: Show the video on the card**

In `TikTokForWork/Features/Feed/DecisionCardView.swift`, render the restored player when the card has a video. Place it under the card's summary/context block:

```swift
            if let videoURL = card.videoURL, let url = URL(string: videoURL) {
                CardVideoView(url: url)
                    .frame(height: 220)
                    .clipShape(RoundedRectangle(cornerRadius: Theme.Radius.image))
            }
```
(Read `CardVideoView`'s restored initializer first — if it takes a `String` or a different label, match it exactly. `Theme.Radius.image` exists in `Theme.swift`.)

- [ ] **Step 5: Build**

Run the iOS build command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 6: Commit**

```bash
git add TikTokForWork/Models/DecisionCard.swift TikTokForWork/Services/DecisionCardService.swift TikTokForWork/ViewModels/FeedViewModel.swift TikTokForWork/Features/Feed/DecisionCardView.swift
git commit -m "feat(ios): decision cards carry a video"
```

---

## Task 7: Wire `+` to capture → upload → route

**Files:**
- Modify: `TikTokForWork/Features/Shell/AppShell.swift`, `TikTokForWork/Services/MediaUploader.swift`, `TikTokForWork/Features/Feed/FeedView.swift`

- [ ] **Step 1: Point `MediaUploader` at the hosted Worker and authenticate**

The restored `MediaUploader.upload(_:to:)` posts raw bytes to `/media` and decodes `{ id, url }` — that matches Task 3's response. Add the session header so the Worker accepts it:

```swift
        var request = URLRequest(url: endpoint)
        request.httpMethod = "POST"
        request.timeoutInterval = 60
        request.setValue("video/mp4", forHTTPHeaderField: "Content-Type")
        if let token = SessionStore.sessionToken {
            request.setValue(token, forHTTPHeaderField: "x-session-token")
        }
```
(Insert the timeout + header lines into the existing request construction; leave the `URLSession.shared.upload(for:fromFile:)` call as is.)

- [ ] **Step 2: Reopen `CaptureView` from the `+` button**

In `TikTokForWork/Features/Shell/AppShell.swift`, Phase 4C repointed `+` to bump `composeTick` (the text sheet). Restore the capture presentation:

```swift
    @State private var showCapture = false
    @State private var captured: CaptureRequest?
```
Present it over the shell:
```swift
        .fullScreenCover(isPresented: $showCapture) {
            CaptureView { text, video in
                showCapture = false
                Task { await handleCapture(text: text, video: video) }
            }
            .environmentObject(appState)
        }
```
and make the `+` action `showCapture = true`.

Add the handler (uploads first, then hands a `CaptureRequest` to the feed):

```swift
    private func handleCapture(text: String, video: URL?) async {
        guard !text.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return }
        var uploaded: String?
        if let video {
            let local = MediaStore.keep(video)
            if let base = appState.backendBaseURL, let file = local ?? Optional(video) {
                uploaded = try? await MediaUploader.upload(file, to: base)
            }
            if uploaded == nil { uploaded = local?.absoluteString }
        }
        captured = CaptureRequest(text: text, videoURL: uploaded)
    }
```
(Read `MediaStore.keep`'s restored signature and `CaptureRequest`'s initializer first and match them exactly; the intent is: keep the clip locally so a failed upload still plays back, upload when possible, and fall back to the local URL.)

- [ ] **Step 3: Feed consumes the capture**

In `TikTokForWork/Features/Feed/FeedView.swift`, re-add the `captured` input and start a draft when it arrives:

```swift
    var captured: CaptureRequest?
```
```swift
        .onChange(of: captured) { _, request in
            guard let request else { return }
            viewModel.beginDraft(request.text, priority: .medium, appState: appState, videoURL: request.videoURL)
        }
```
and pass it from `AppShell`'s `FeedView(...)` call site: `FeedView(showsChrome: false, composeTick: composeTick, captured: captured)`.
(Match the actual `FeedView` initializer parameters; `CaptureRequest` must be `Equatable` for `.onChange` — the restored model is a simple struct, so add `: Equatable` to its declaration if the compiler asks.)

- [ ] **Step 4: Build**

Run the iOS build command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Simulator smoke (non-camera)**

```bash
DEV=$(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}' | head -1)
APP=$(find ~/Library/Developer/Xcode/DerivedData/TikTokForWork-*/Build/Products/Debug-iphonesimulator -maxdepth 1 -name "TikTokForWork.app" | head -1)
xcrun simctl install "$DEV" "$APP" && xcrun simctl launch "$DEV" com.honmaru.ai -RelayURL "ws://127.0.0.1:9999"
```
Expected: launches with a PID and no crash. The simulator has no camera, so `CaptureView` will show an empty viewfinder — that is expected; the device check below is the real test.

- [ ] **Step 6: Commit**

```bash
git add TikTokForWork/Features/Shell/AppShell.swift TikTokForWork/Services/MediaUploader.swift TikTokForWork/Features/Feed/FeedView.swift TikTokForWork/Models/CaptureRequest.swift
git commit -m "feat(ios): + records a video and routes what you said"
```

- [ ] **Step 7: Ship to TestFlight for the device check**

```bash
cd /Users/torutano/HonmaruAI
./scripts/release.sh build 1.0
./scripts/release.sh testflight --yes
```
Expected: a new build number, `processingState: VALID`.

**Device checklist (run by the user):** open the app → `+` → the camera appears → record while speaking → stop → the transcript is the instruction and is editable → send → a Decision Card is routed to a real teammate → on the recipient's device the card plays your video.

---

## Self-Review Notes (addressed)

- **Spec coverage:** adaptive palette + dark values (Task 1), appearance setting/root/picker/ja strings (Task 2), R2 media endpoints with session auth and 401/404 cases (Task 3), bucket + deploy smoke (Task 4), capture stack restore incl. re-added privacy strings and localization of the restored Japanese (Task 5), `videoURL` on the card end-to-end (Task 6), `+` → capture → upload → route and the TestFlight device check (Task 7).
- **Light mode unchanged:** Task 1 keeps every light hex byte-identical; only dark values are new.
- **Type consistency:** `MediaUploader.upload(_:to:) -> String` (the URL) matches the Worker's `{ id, url }` response; `CaptureRequest(text:videoURL:)` feeds `FeedViewModel.beginDraft(..., videoURL:)` → `DecisionCardService.processRouting(..., videoURL:)` → `DecisionCard.videoURL` → `CardVideoView`. The same `videoURL` string is the R2 `GET /media/:id` URL.
- **Guest path:** uploads require `x-session-token`, so a guest (no session) records and routes text but gets no video attachment — matches the spec's out-of-scope note.
- **Known device-only:** camera, dictation, and the real upload need hardware; the simulator verifies compile + non-camera UI (called out in Tasks 5–7).
