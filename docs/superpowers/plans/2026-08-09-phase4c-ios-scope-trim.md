# Phase 4C: iOS Scope-Trim Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the demo/scope-creep surfaces the product no longer uses — the Slack-style "Classic" view, the camera/video capture stack, and `DemoData.swift` — so the app is only the real Decision-Card feed + org + AI, with no demo dependencies.

**Architecture:** First replace the last `DemoData.userName(for:)` / `DemoUser` references with an org-derived display-name helper (so nothing outside `DemoData.swift` references it), then delete the dead files and prune their wiring in `AppShell`/`FeedView`/`FeedViewModel`/`DecisionCardView`, building to green after each step. No test target — verification is `** BUILD SUCCEEDED **` plus a simulator launch smoke.

**Tech Stack:** SwiftUI, xcodegen (`sources` is folder-based — deleting a `.swift` file + `xcodegen generate` drops it from the target; no `project.yml` edit needed), `xcodebuild`.

## Verification model

```
cd /Users/torutano/HonmaruAI && xcodegen generate && \
xcodebuild -project TikTokForWork.xcodeproj -scheme TikTokForWork \
  -destination 'generic/platform=iOS Simulator' -configuration Debug build 2>&1 | tail -6
```
"Build succeeds" = `** BUILD SUCCEEDED **`. A final simulator launch confirms the app still reaches onboarding/feed.

## Files to delete (Task 2)

- `Data/DemoData.swift`
- `Features/Shell/ClassicListView.swift`, `ClassicChannelView.swift`, `SlackPalette.swift`, `HomeSegmentedControl.swift`
- `Features/Shell/CaptureView.swift`, `CameraViewfinder.swift`
- `Features/Feed/CardVideoView.swift`
- `Services/VideoRecorder.swift`, `MediaUploader.swift`, `MediaStore.swift`, `DictationService.swift`, `ChatStore.swift`
- `Models/CaptureRequest.swift`

(`SlackPalette.swift` holds the `Slack.*` palette used only by the Classic views. `DictationService` is used only by `CaptureView`. Confirm each has no remaining references after Task 2's pruning — the build will surface any.)

---

## Task 1: Replace DemoData name resolvers with an org-derived helper

**Files:**
- Create: `TikTokForWork/Models/DisplayName.swift`
- Modify: `Models/AgentModels.swift`, `Models/DecisionCard.swift`, `Models/Organization.swift`, `Services/DecisionCardService.swift`, `Services/OfflineRouter.swift`, `Services/AIService.swift`

- [ ] **Step 1: Create the shared helper `TikTokForWork/Models/DisplayName.swift`**

```swift
import Foundation

/// Resolves a user id to a human display name. For real users the id is the
/// GitHub login, which is already a fine name; when an org graph is available
/// we prefer the person node's label (the text before " · <role>").
enum DisplayName {
    static func of(_ userID: String, in organization: OrganizationGraph? = nil) -> String {
        if let node = organization?.nodes.first(where: { $0.id == userID && $0.kind == .person }) {
            return node.label.split(separator: "·").first
                .map { $0.trimmingCharacters(in: .whitespaces) } ?? userID
        }
        return userID
    }
}
```

- [ ] **Step 2: Replace each `DemoData.userName(for:)` call site**

- `Models/AgentModels.swift` (`recipientName`, ~line 48):
```swift
    var recipientName: String {
        DisplayName.of(recipientUserID)
    }
```
- `Models/DecisionCard.swift` (`senderName`, ~line 107):
```swift
    var senderName: String {
        DisplayName.of(senderUserID)
    }
```
- `Models/Organization.swift` (`routingReason`, ~line 52) — `self` is the org graph, so pass it:
```swift
        return "You are \(DisplayName.of(senderID, in: self))'s manager"
```
- `Services/DecisionCardService.swift`:
  - ~line 162 (no org in scope here → raw id is fine): `summary: "\(DisplayName.of(actorUserID)) · \(statusLabel)",`
  - ~lines 210-211 (the `delegate(...)` method has `organization` in scope):
```swift
        let actorName = DisplayName.of(actorUserID, in: organization)
        let recipientName = DisplayName.of(recipientUserID, in: organization)
```
  (Read the surrounding code to confirm `organization` is the parameter name; if the method's org value has a different name, use it.)
- `Services/OfflineRouter.swift`:
  - ~line 34, replace the hardcoded demo default recipient `recipient = DemoUser.toru.user.id` with routing back to the sender (offline has no org to pick from):
```swift
        recipient = sender.id
```
  - ~line 62: `agentRoute: String(localized: "\(sender.name) → \(DisplayName.of(recipient))"),`

- [ ] **Step 3: Consolidate AIService's private name helper (optional but clean)**

`AIService` added a private `name(for:in:)` in Phase 4. Replace its body to delegate, so there is one implementation:
```swift
    private func name(for userID: String, in organization: OrganizationGraph) -> String {
        DisplayName.of(userID, in: organization)
    }
```
(Or replace call sites with `DisplayName.of(...)` and delete the private method — either is fine. Keep it minimal.)

- [ ] **Step 4: Confirm DemoData is now unreferenced outside its own file**

Run: `grep -rn "DemoData\.\|DemoUser\|DemoAgent" TikTokForWork --include=*.swift | grep -v "Data/DemoData.swift"`
Expected: NO output (every external reference is gone). If any remain (e.g. a `DemoUser` in `ChatStore.swift` — that file is deleted in Task 2, so a reference there is acceptable since the file goes away), note it; the only acceptable remaining references are inside files that Task 2 deletes.

- [ ] **Step 5: Build**

Run the build command. Expected: `** BUILD SUCCEEDED **` (DemoData.swift still exists, just no longer referenced for names).

- [ ] **Step 6: Commit**

```bash
git add TikTokForWork/Models/DisplayName.swift TikTokForWork/Models/AgentModels.swift TikTokForWork/Models/DecisionCard.swift TikTokForWork/Models/Organization.swift TikTokForWork/Services/DecisionCardService.swift TikTokForWork/Services/OfflineRouter.swift TikTokForWork/Services/AIService.swift
git commit -m "refactor(ios): org-derived display names, drop DemoData.userName"
```

---

## Task 2: Delete the Classic + camera/video surfaces and DemoData; prune wiring

This is a coupled deletion — do it all, then build to green.

**Files:**
- Delete: the 14 files listed in "Files to delete" above.
- Modify: `Features/Shell/AppShell.swift`, `Features/Feed/FeedView.swift`, `ViewModels/FeedViewModel.swift`, `Features/Feed/DecisionCardView.swift`, `App/AppState.swift`, `Features/Shell/AppTabBar.swift` (if it references the capture/compose entry).

- [ ] **Step 1: Delete the dead files**

```bash
cd /Users/torutano/HonmaruAI
git rm TikTokForWork/Data/DemoData.swift \
  TikTokForWork/Features/Shell/ClassicListView.swift \
  TikTokForWork/Features/Shell/ClassicChannelView.swift \
  TikTokForWork/Features/Shell/SlackPalette.swift \
  TikTokForWork/Features/Shell/HomeSegmentedControl.swift \
  TikTokForWork/Features/Shell/CaptureView.swift \
  TikTokForWork/Features/Shell/CameraViewfinder.swift \
  TikTokForWork/Features/Feed/CardVideoView.swift \
  TikTokForWork/Services/VideoRecorder.swift \
  TikTokForWork/Services/MediaUploader.swift \
  TikTokForWork/Services/MediaStore.swift \
  TikTokForWork/Services/DictationService.swift \
  TikTokForWork/Services/ChatStore.swift \
  TikTokForWork/Models/CaptureRequest.swift
```

- [ ] **Step 2: Prune `AppShell.swift`**

Remove every reference to the deleted types. Specifically:
- Delete `@State private var surface: HomeSurface = .cards` and the `.cards`/`.classic` switch — render `FeedView` directly.
- Delete the `showCapture`/`pendingCapture`/`captured` capture state, the `.fullScreenCover { CaptureView(...) }`, and the `handleCapture()` method.
- Delete the `HomeSegmentedControl(...)` control and the `openCount` computed property.
- Delete the `appState.chatStore.recordDecision(...)` call.
- Keep the `FeedView` (now without `captured:`), the tab bar, and the `OrgGraphView`/`YouView` navigation. Simplify `FeedView`'s init call to drop the `captured:` argument (see Step 4).

Read the file and make the smallest edits that compile. If a `+` FAB previously opened capture, repoint it to the existing AI text-input entry (the feed's "Tell your AI" input) instead of the camera.

- [ ] **Step 3: Prune `FeedViewModel.swift`**

Remove `pendingVideoURL`, the `videoURL` parameter of `beginDraft(...)`, and the `videoURL: pendingVideoURL` argument passed to the card-routing call. `beginDraft` becomes `beginDraft(_ text:priority:appState:)`.

- [ ] **Step 4: Prune `FeedView.swift`**

Remove the `captured: CaptureRequest?` property and any `.onChange(of: captured)` capture handling, and the `chatStore.recordDecision(...)` call. Keep the AI text-input compose path. Update the `AppShell` call site accordingly (Step 2).

- [ ] **Step 5: Prune `DecisionCardView.swift`**

Remove the `CardVideoView(...)` usage (shown when `card.videoURL != nil`). Leave the `DecisionCard.videoURL` model field in place ONLY if removing it cascades into the card `dictionary`/Codable plumbing; prefer removing the field and its encode/decode if it is self-contained. Whichever you choose, the card must still build and render without video.

- [ ] **Step 6: Remove `ChatStore` from `AppState.swift`**

Delete `let chatStore = ChatStore()` (line ~16) and any other `chatStore` references in `AppState`.

- [ ] **Step 7: Build and fix to green**

Run: `cd /Users/torutano/HonmaruAI && xcodegen generate && xcodebuild -project TikTokForWork.xcodeproj -scheme TikTokForWork -destination 'generic/platform=iOS Simulator' -configuration Debug build 2>&1 | tail -25`
Iterate on the compile errors (they precisely list every remaining reference to a deleted type) until `** BUILD SUCCEEDED **`.

- [ ] **Step 8: Confirm no dangling references**

Run: `grep -rn "Classic\|SlackPalette\|HomeSegmentedControl\|CaptureView\|CameraViewfinder\|CardVideoView\|VideoRecorder\|MediaUploader\|MediaStore\|DictationService\|ChatStore\|CaptureRequest\|DemoData\|DemoUser\|DemoAgent" TikTokForWork --include=*.swift`
Expected: NO output.

- [ ] **Step 9: Info.plist camera/mic usage keys (optional cleanup)**

If `TikTokForWork/Info.plist` (or the `INFOPLIST_KEY_*` in `project.yml`) declares `NSCameraUsageDescription` / `NSMicrophoneUsageDescription` / `NSSpeechRecognitionUsageDescription`, remove them since capture is gone (App Review flags unused permission strings). If they live in `project.yml` as `INFOPLIST_KEY_*`, edit there and re-generate.

- [ ] **Step 10: Simulator launch smoke**

```bash
DEV=$(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}' | head -1)
APP=$(find ~/Library/Developer/Xcode/DerivedData/TikTokForWork-*/Build/Products/Debug-iphonesimulator -maxdepth 1 -name "TikTokForWork.app" | head -1)
xcrun simctl install "$DEV" "$APP" && xcrun simctl launch "$DEV" com.honmaru.ai
```
Confirm the app launches to onboarding (no crash, no Classic tab / camera FAB). (Full flow still requires a real device per Phase 4's HTTP/3 note.)

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat(ios): remove Slack-Classic, camera/video, and DemoData"
```

---

## Self-Review Notes (addressed)

- **Spec coverage:** removes Slack-Classic (ClassicListView/ClassicChannelView/SlackPalette/HomeSegmentedControl), camera/video (CaptureView/CameraViewfinder/VideoRecorder/Media*/DictationService/CardVideoView/CaptureRequest), and `DemoData.swift`; the last `DemoData.userName`/`DemoUser` uses are replaced first (Task 1) so deletion is safe.
- **Ordering:** Task 1 makes DemoData unreferenced; Task 2 deletes. Building after each catches stragglers.
- **Blast radius handled:** `AppShell` capture+classic wiring, `FeedView`/`FeedViewModel` video params, `DecisionCardView` video view, `AppState.chatStore` — all pruned; grep gate (Step 8) proves no dangling refs.
- **Kept intact:** the real Decision-Card feed, AI text input, org graph, GitHub connect, relay, and the Phase-4 identity/org path.
