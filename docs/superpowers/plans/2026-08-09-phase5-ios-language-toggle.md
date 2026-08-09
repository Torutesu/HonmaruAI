# Phase 5: iOS Language Toggle (English default + Japanese) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the app English-by-default with an in-app language toggle (System / English / 日本語) that switches the UI at runtime, and have AI-generated card text follow the chosen language.

**Architecture:** English is already the source language of `Localizable.xcstrings` (with full `ja` translations), so "English default" holds. Add an `AppLanguage` setting persisted in `UserDefaults`, injected as `\.environment(\.locale, …)` at the root so SwiftUI `Text` re-localizes live; persist `AppleLanguages` too so `String(localized:)` sites follow on next launch. The chosen language is threaded to `AIService` so `/ai/route`'s `readerLanguage` reflects it. A picker in `YouView` replaces the current "open iOS Settings" row. Finally, remaining hardcoded Japanese literals are moved into the catalog. No test target — verification is `** BUILD SUCCEEDED **` plus a simulator screenshot showing the toggle switching the UI (this is network-free, so it works in the simulator).

**Tech Stack:** SwiftUI, `Localizable.xcstrings` string catalog, `xcodebuild`.

## Verification model

Build: `cd /Users/torutano/HonmaruAI && xcodegen generate && xcodebuild -project TikTokForWork.xcodeproj -scheme TikTokForWork -destination 'generic/platform=iOS Simulator' -configuration Debug build 2>&1 | tail -6` → `** BUILD SUCCEEDED **`. Language switching is verified by a simulator screenshot of `YouView` before/after toggling (Task 3).

## Key facts (verified)

- `Localizable.xcstrings`: `"sourceLanguage": "en"`, ~234 keys with `ja` translations. Strings referenced via a mix of `Text("…")` (LocalizedStringKey — honors `\.environment(\.locale)`) and `String(localized: "…")` (Foundation — honors the bundle/`AppleLanguages`, NOT the SwiftUI env locale).
- Root: `TikTokForWorkApp.swift:10` → `RootView().environmentObject(appState)`. No existing language override.
- `YouView` has a `row("言語", value: currentLanguage)` that currently opens iOS Settings (lines ~46-52); `currentLanguage` reads `Bundle.main.preferredLocalizations.first`.
- `AIService` (`routeInstruction`, ~line 148) sends `readerLanguage: Locale.current.language.languageCode?.identifier ?? "ja"`. `Locale.current` does NOT reflect a SwiftUI `\.locale` override, so the chosen language must be passed explicitly.
- Hardcoded Japanese literals remain in `YouView`, `AppShell` (accessibility "あなた"), `AppTabBar` ("ホーム"/"あなた"/"作成"), `DecisionCardView` ("返信または音声入力…"), `SourceSheet` (demo field labels), `TranslatedFrom`, `ReviseSheet`. (CaptureView/ClassicChannelView literals are gone with Phase 4C.)

---

## Task 1: Language setting infrastructure

**Files:**
- Create: `TikTokForWork/App/AppLanguage.swift`
- Modify: `TikTokForWork/App/AppState.swift`, `TikTokForWork/TikTokForWorkApp.swift`

- [ ] **Step 1: Create `TikTokForWork/App/AppLanguage.swift`**

```swift
import Foundation

/// The user's UI language choice. `.system` follows the device.
enum AppLanguage: String, CaseIterable, Identifiable {
    case system
    case english = "en"
    case japanese = "ja"

    var id: String { rawValue }

    var label: String {
        switch self {
        case .system: return String(localized: "System")
        case .english: return "English"
        case .japanese: return "日本語"
        }
    }

    /// The locale to apply, or nil to follow the system.
    var locale: Locale? {
        switch self {
        case .system: return nil
        case .english: return Locale(identifier: "en")
        case .japanese: return Locale(identifier: "ja")
        }
    }

    /// The reader-language code sent to the AI, resolved against the system
    /// when `.system`.
    var readerLanguageCode: String {
        switch self {
        case .system: return Locale.current.language.languageCode?.identifier ?? "en"
        case .english: return "en"
        case .japanese: return "ja"
        }
    }
}
```

- [ ] **Step 2: Add the setting to `AppState`**

```swift
    @Published var language: AppLanguage = {
        AppLanguage(rawValue: UserDefaults.standard.string(forKey: "appLanguage") ?? "system") ?? .system
    }() {
        didSet { applyLanguage() }
    }

    private func applyLanguage() {
        UserDefaults.standard.set(language.rawValue, forKey: "appLanguage")
        // Persist for String(localized:) / bundle lookups on next launch.
        if let code = language.locale?.identifier {
            UserDefaults.standard.set([code], forKey: "AppleLanguages")
        } else {
            UserDefaults.standard.removeObject(forKey: "AppleLanguages")
        }
    }

    /// The reader language to send to the AI for card generation.
    var readerLanguageCode: String { language.readerLanguageCode }
```

- [ ] **Step 3: Inject the locale at the root**

In `TikTokForWorkApp.swift`, apply the chosen locale so SwiftUI `Text` re-localizes live:

```swift
            RootView()
                .environmentObject(appState)
                .environment(\.locale, appState.language.locale ?? Locale.autoupdatingCurrent)
```

- [ ] **Step 4: Build**

Run the build command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 5: Commit**

```bash
git add TikTokForWork/App/AppLanguage.swift TikTokForWork/App/AppState.swift TikTokForWork/TikTokForWorkApp.swift
git commit -m "feat(ios): app language setting with root locale override"
```

---

## Task 2: AI reader language follows the choice

**Files:**
- Modify: `TikTokForWork/Services/AIService.swift`, `TikTokForWork/ViewModels/FeedViewModel.swift`

- [ ] **Step 1: Add a `readerLanguage` parameter to the AI calls**

In `AIService`, thread an explicit reader language through `draftInstruction` and `routeInstruction` instead of reading `Locale.current`. Change the `routeInstruction` signature to accept `readerLanguage: String` and use it in the request body:

```swift
    func routeInstruction(
        text: String,
        sender: User,
        organization: OrganizationGraph,
        priorityOverride: CardPriority? = nil,
        readerLanguage: String
    ) async throws -> InstructionRouting {
        // …
        RouteInstructionRequest(
            text: text,
            sender: sender,
            organization: organization,
            priorityOverride: priorityOverride?.rawValue,
            readerLanguage: readerLanguage
        )
        // …
    }
```

Do the same for `draftInstruction(text:sender:organization:priorityOverride:readerLanguage:)`, forwarding it to `routeInstruction`.

- [ ] **Step 2: Pass the chosen language from the feed**

In `FeedViewModel.draftInstruction(...)`, pass `readerLanguage: appState.readerLanguageCode` into `appState.aiService.draftInstruction(...)`.

- [ ] **Step 3: Build**

Run the build command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Commit**

```bash
git add TikTokForWork/Services/AIService.swift TikTokForWork/ViewModels/FeedViewModel.swift
git commit -m "feat(ios): AI card language follows the app language setting"
```

---

## Task 3: Language picker in YouView

**Files:**
- Modify: `TikTokForWork/Features/Shell/YouView.swift`

- [ ] **Step 1: Replace the "open iOS Settings" language row with an in-app picker**

Remove the `row("言語", …) { open UIApplication.openSettingsURLString }` action and the stale comment. Add a `@EnvironmentObject var appState: AppState` (if not already present) and a picker bound to `appState.language`:

```swift
        Picker(selection: $appState.language) {
            ForEach(AppLanguage.allCases) { lang in
                Text(lang.label).tag(lang)
            }
        } label: {
            Text("Language")
        }
        .pickerStyle(.menu)
```

Place it where the language row was. Keep the version row. Ensure `YouView` receives `appState` from its parent (`AppShell` already injects `.environmentObject(appState)` on the tab content).

- [ ] **Step 2: Build**

Run the build command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 3: Simulator smoke — the toggle switches the UI (network-free)**

```bash
DEV=$(xcrun simctl list devices booted | grep -oE '[0-9A-F-]{36}' | head -1)
APP=$(find ~/Library/Developer/Xcode/DerivedData/TikTokForWork-*/Build/Products/Debug-iphonesimulator -maxdepth 1 -name "TikTokForWork.app" | head -1)
xcrun simctl install "$DEV" "$APP" && xcrun simctl launch "$DEV" com.honmaru.ai -RelayURL "ws://127.0.0.1:9999"
# (dead relay URL so it reaches the UI without waiting on the backend)
```
Navigate to the "You" tab, open the language picker, choose English then 日本語, and screenshot each (`xcrun simctl io "$DEV" screenshot …`). Confirm the visible labels switch language. (Driving taps may require the user; if tap automation isn't available, hand this screenshot check to the user, but the build must pass.)

- [ ] **Step 4: Commit**

```bash
git add TikTokForWork/Features/Shell/YouView.swift
git commit -m "feat(ios): in-app language picker (System / English / 日本語)"
```

---

## Task 4: Move remaining hardcoded Japanese literals into the catalog

**Files:**
- Modify: the views with hardcoded Japanese literals (`YouView`, `AppShell`, `AppTabBar`, `DecisionCardView`, `SourceSheet`, `TranslatedFrom`, `ReviseSheet`), and `Localizable.xcstrings`.

- [ ] **Step 1: Convert hardcoded literals to localized keys**

For each hardcoded Japanese string, replace it with the ENGLISH source key and let the catalog carry the Japanese translation. Examples:
- `AppTabBar`: `Text("ホーム")` → `Text("Home")`, `Text("あなた")` → `Text("You")`, `Text("作成")` → `Text("Create")`.
- `AppShell`: `.accessibilityLabel(Text("あなた"))` → `.accessibilityLabel(Text("You"))`.
- `YouView`: `row("あなたの AI", …)` → `row("Your AI", …)`, `"接続済み"`/`"未設定"` → `"Connected"`/`"Not set"`, `"組織"` → `"Organization"`, `"バージョン"` → `"Version"`, `"サインアウト"` → `"Sign out"`, `"準備中"` → `"Coming soon"`, etc.
- `DecisionCardView`: `Text("返信または音声入力…")` → `Text("Reply…")` (dictation is gone post-4C, so drop "音声入力").
- `SourceSheet`: the demo field labels ("差出人"/"宛先"/…) → English keys ("From"/"To"/"Subject"/"Assignee"/"Status"/"Updated"/"Participants"/"Location") and the disclaimer to an English key.
- `TranslatedFrom`: `Text("\(displayLanguage)から翻訳")` → `Text("Translated from \(displayLanguage)")`.
- `ReviseSheet`: `"停止"` → `"Stop"`.

Use `Text("English")` (LocalizedStringKey) so the env-locale override applies. For non-Text sites (e.g. a `row(_ title: String, …)` that takes a plain String), pass `String(localized: "English")` so the bundle localizes it.

- [ ] **Step 2: Add the Japanese translations to `Localizable.xcstrings`**

For every new English key that lacks a `ja` entry, add the Japanese translation (reuse the original literal, e.g. `"Home"` → `"ホーム"`, `"Sign out"` → `"サインアウト"`). Open `TikTokForWork/Localizable.xcstrings` and add/verify the `"ja"` localization for each new key. (The catalog is JSON; add entries in the same shape as existing keys: `"Home" : { "localizations" : { "ja" : { "stringUnit" : { "state" : "translated", "value" : "ホーム" } } } }`.)

- [ ] **Step 3: Build**

Run the build command. Expected: `** BUILD SUCCEEDED **`.

- [ ] **Step 4: Simulator smoke**

Relaunch and confirm: with English selected, the tab bar/settings read English; with 日本語, they read Japanese. Screenshot both. (Hand tap-driving to the user if needed.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(ios): localize remaining hardcoded strings, en base + ja"
```

---

## Self-Review Notes (addressed)

- **Spec coverage:** English default (already the source language) + in-app System/English/日本語 toggle (Tasks 1, 3); AI card text follows the choice (Task 2); remaining hardcoded literals localized (Task 4).
- **Known limitation (documented):** `.environment(\.locale)` re-localizes SwiftUI `Text` live, but `String(localized:)` reads the bundle/`AppleLanguages`, which fully applies on the next launch — so a few settings-screen strings that use `String(localized:)` may switch on relaunch rather than instantly. `AppleLanguages` is persisted in Task 1 to guarantee full application on relaunch; most visible UI uses `Text` and switches live. If instant switching of a specific `String(localized:)` label matters, convert that site to `Text`.
- **AIService correctness:** `Locale.current` wouldn't reflect the override, so the reader language is threaded explicitly from `AppState.readerLanguageCode` (Task 2) — the server then writes cards in the chosen language.
- **Ordering vs Phase 4C:** run after 4C so the deleted CaptureView/Classic literals aren't part of the migration set.
