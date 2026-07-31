# Cross-Platform Architecture — iOS · macOS · Web

How TikTok for Work grows from an iOS app into a work OS that lives on every screen, without forking product logic per platform.

## 0. The one structural decision that makes this cheap

**All product intelligence already lives on the relay.** Routing, triage, reply interpretation, translation, digests, recommendations, escalation, org graph, persistence, push policy — none of it is in Swift. Clients are thin: they render state, capture input, and speak two protocols:

1. **WebSocket** — join/snapshot + deltas (`card_*`, `channel_*`, `org_updated`, `presence`)
2. **HTTPS** — `/ai/*`, `/org/*`, `/digest/run`, `/push/register`, OAuth exchange

A new platform is therefore a **rendering + input problem, not a logic problem**. This document keeps it that way.

```
                    ┌───────────────────────────────┐
   iOS (SwiftUI) ──▶│                               │
 macOS (SwiftUI) ──▶│   Relay = the product brain   │──▶ OpenRouter / GitHub / APNs
   Web (React)   ──▶│   (protocol = platform API)   │
                    └───────────────────────────────┘
```

**Rule: any feature that can live in the relay lives in the relay.** A feature implemented client-side must be justified (latency, hardware access, offline).

---

## 1. Layering

| Layer | Contents | iOS | macOS | Web |
|---|---|---|---|---|
| L0 Protocol | WS message types, REST shapes, model schemas | shared spec (§2) | ← | ← |
| L1 Core | models, stores, WS client, API client, view models | **TTFWCore** SwiftPM package | ← same package | TypeScript `@ttfw/core` (generated models + hand-written stores) |
| L2 Design tokens | colors (dark+light), type scale, spacing, radius, motion | generated Swift | ← | generated CSS variables |
| L3 UI shell | navigation, layout idiom, input methods | SwiftUI (feed-first) | SwiftUI (three-column) | React (responsive) |
| L4 Platform services | push, voice, keychain, OAuth presentation | APNs/Speech/Keychain/ASWebAuth | same APIs, mac variants | WebPush/WebSpeech/localStorage†/redirect OAuth |

† secrets handling differs — see §6.

### 1.1 TTFWCore (Swift package) — the refactor that unlocks macOS

Move out of the app target into `Packages/TTFWCore`:

- `Models/` — `DecisionCard`, `ChatChannel/ChatMessage`, `User`, `OrganizationGraph`, `CardSource`, `RecommendationHint`, `AgentModels`
- `Services/` — `WebSocketService`, `AIService`, `OrganizationService`, `DecisionCardService`, `ChannelService`, `SessionStore` (protocol + Keychain impl), `GitHubService`
- `ViewModels/` — `FeedViewModel` (already UI-agnostic: state in, intents out)

Constraints for the package: **no UIKit imports** (today only `WebAuthContextProvider`, `PushNotificationService`, `SpeechDictation`, `Haptics` touch UIKit — they stay in app targets behind protocols):

```swift
public protocol PushRegistering { func activate(for userID: String) }
public protocol Dictating: ObservableObject { var transcript: String { get }; func start() async; func stop() }
public protocol HapticsProviding { func light(); func success() }
```

iOS/macOS app targets inject platform implementations. `Haptics` on macOS = no-op (or `NSHapticFeedbackManager` on trackpads).

### 1.2 TypeScript `@ttfw/core`

- **Models generated, not hand-written** (§2.3) — drift between Swift and TS is the classic cross-platform failure
- `RelaySocket` (reconnecting WS with the same join/snapshot semantics), `RelayAPI` (fetch wrapper with bearer token), stores (`cardStore`, `channelStore`, `orgStore`) as framework-agnostic observables (zustand), mirroring the Swift service surface **name-for-name** so engineers can navigate both codebases

---

## 2. The protocol is the contract — formalize it

Today the protocol is implicit (Swift Codable ↔ JS objects). Three platforms need it explicit:

### 2.1 Versioning
- WS `join` payload gains `clientVersion` and `protocolVersion`; server replies in the snapshot with its `protocolVersion`
- Rules: **additive changes only** (new fields optional, unknown fields ignored — both Swift Codable and TS handle this today); breaking change ⇒ bump `protocolVersion`, server supports N and N−1 for one release cycle
- New enum values (e.g. a new `CardStatus`) must be tolerated by old clients: TS unions get `| (string & {})`; Swift decodes enums via fallback wrappers before adding new cases

### 2.2 Single schema source
`protocol/schema.json` (JSON Schema) in the repo defines every model and message envelope. It is **the** spec; Swift/TS/server tests all validate against it.

### 2.3 Codegen
- `schema → TypeScript` (quicktype/json-schema-to-ts) into `@ttfw/core/models`
- `schema → Swift` structs into TTFWCore (or keep hand-written Swift + a CI test that round-trips fixtures against the schema — cheaper to start)
- Server: `node --test` fixtures asserting emitted payloads validate against the schema

### 2.4 Message inventory (current)
`join, snapshot, channel_snapshot, card_created, card_updated, card_deleted, channel_message, channel_create(d), org_updated, presence, error` + REST: `/health, /oauth/github/*, /ai/route|ingest|refine|reply, /org, /org/members, /org/language, /push/register, /digest/run, /escalations/run, /github/webhook`.

---

## 3. macOS

**Strategy: native SwiftUI target sharing TTFWCore.** Not Catalyst — the product deserves a real Mac shell (sidebar, keyboard, menu bar), and TTFWCore makes native cheap. One `.xcodeproj` (XcodeGen), two app targets.

### 3.1 Layout idiom — the feed becomes a workbench

```
┌────────────┬──────────────────────────┬───────────────────┐
│  Sidebar   │   Decision queue         │   Context panel   │
│  Feed      │   (cards as focused      │   source channel  │
│  Channels  │    list, ⌘-navigable)    │   conversation /  │
│  #general  │                          │   card detail /   │
│  #launch   │   [card] [card] [card]   │   GitHub link     │
│  Org       │                          │                   │
│  Settings  │                          │                   │
└────────────┴──────────────────────────┴───────────────────┘
```

- `NavigationSplitView` three-column; the phone's "one card fills the screen" becomes "one card holds focus" — selected card enlarged, glow treatment intact
- **The provenance feature becomes spatial**: selecting a card shows its source conversation in the third column — no navigation at all, the summary and the source visible together (the fastest possible "最短で意思決定")
- Same `FeedViewModel`; selection state added for the Mac shell

### 3.2 Mac-specific power
- **Keyboard-first deciding**: `⏎` approve · `⌫` decline · `R` reply · `A` Ask AI · `D` delegate · `↑↓`/`J K` navigate · `⌘1/2/3` sections — via `.keyboardShortcut` + a `DecideCommands` menu (also gives Mac menu-bar semantics for free)
- **Menu bar extra** (`MenuBarExtra`): pending-decision count; click → mini decision popover; global hotkey ⌥Space = "Tell your AI" quick capture from any app
- **Notifications**: `UserNotifications` works as-is; APNs via the same `/push/register` (registry is platform-agnostic — token is a token)
- Voice (`Speech`), Keychain, `ASWebAuthenticationSession` — all available on macOS with the same APIs; `WebAuthContextProvider` gets an `NSWindow` presentation anchor variant
- Window restoration, `⌘,` opens Settings (same SettingsView, `Form`-adapted)

### 3.3 Effort estimate
TTFWCore extraction 1–2 days; Mac shell (split view, keyboard, menu bar) 2–3 days; polish 1–2 days. **~1 week to a credible Mac app** — that's the payoff of a thin client.

## 4. Web

> **Implementation-ready plan: [WEB_PLAN.md](WEB_PLAN.md)** — verified gap analysis against the current relay, locked stack decisions, file layout, endpoint specs, 7 phases with estimates and acceptance criteria. Read that to build; read this section for the architectural frame.

**Strategy: React + TypeScript thin client on `@ttfw/core`** (Vite or Next.js static; no server rendering needed — the relay is the server). Swift-to-WASM rejected: immature, heavy payloads, poor a11y; the HTML demo already proved the UI ports naturally to the DOM.

### 4.1 Responsive behavior
- **≤768px**: the phone experience — full-screen snap-scroll cards (CSS scroll-snap, as in the demo), bottom compose bar
- **>768px**: the Mac workbench layout — sidebar / queue / context panel (CSS grid, same three-column contract as §3.1 so the two desktop experiences match)

### 4.2 Component mapping

| SwiftUI | Web |
|---|---|
| DecisionCardView | `<DecisionCard>` (framer-motion drag for swipe, buttons always visible) |
| ChannelTimelineView | `<ChannelTimeline>` (virtualized list, scroll-to-message for provenance) |
| Sheets (reply/AskAI/draft review) | `<BottomSheet>` mobile / `<Dialog>` desktop (Radix, a11y for free) |
| PrioritySlider, chips, rec row | direct ports; tokens via CSS variables |
| SettingsView | `/settings` route |

### 4.3 Platform services
- **Auth**: GitHub OAuth needs a web variant — custom-scheme callbacks don't exist. Add relay support for `redirect_uri = https://app…/oauth/callback` + `state` + PKCE; web exchanges the code via the same `/oauth/github/token`. GitHub API calls from the browser hit CORS → add a thin relay proxy for the few Issue endpoints (`/github/issues/*` forwarding the user token) — also removes the token from browser JS
- **Secrets**: relay token + GitHub token in memory + `sessionStorage` (documented XSS tradeoff), never `localStorage` long-term; CSP locked to the relay origin
- **Push**: Web Push (VAPID) — extend `/push/register` with `{platform: "web", subscription}`; `push.js` gains a `sendWebPush` branch. Same quiet policy, zero policy duplication
- **Voice**: Web Speech API where available (Chrome/Safari), mic hidden where not — same "transcript is editable before send" contract
- **Realtime**: the same `wss://`; browsers can't set WS headers, but our auth is already in the `join` payload — works unchanged

## 5. Design tokens — one source, every platform

`design/tokens.json` (name → {dark, light} + type/spacing/radius/motion) becomes the single source:

- → Swift: tiny generator emits `Theme.Colors` adaptive colors (exactly today's shape — the v2 theme was built to be generated)
- → CSS: `:root { --bg: … }` + `[data-theme="dark"]` overrides; the demo's token block is the prototype
- CI check: token drift fails the build. Glow/gradient recipes documented in design.md; implemented natively per platform (shadow vs box-shadow)

## 6. Cross-cutting decisions

| Concern | Decision |
|---|---|
| State authority | Relay always wins; clients render snapshots + deltas, optimistic updates only for own actions (current iOS behavior, keep) |
| Offline | Read-only cache of last snapshot (Core Data / IndexedDB); queued outbound actions v2 — requires idempotency keys on WS mutations (add `clientRequestID`, relay dedupes) |
| Identity | Today: org-member pick + relay token. Multi-platform forces real sessions: GitHub OAuth → relay-issued session JWT per device; `/push/register` and WS join carry it. One design, all platforms |
| i18n of chrome | UI strings per platform (SwiftUI String Catalog / react-i18next), driven by the same `user.language` — content translation stays server-side |
| Testing | Relay: `node --test` (82) stays the product-logic suite. TTFWCore: XCTest on stores/view models. Web: vitest on stores + Playwright happy-path. Contract: schema round-trip fixtures shared by all three |
| Analytics/metrics | Relay-side (it sees every decision) — decision lead time etc. become server metrics, no client SDKs |

## 7. Phased roadmap

| Phase | Scope | Exit criteria |
|---|---|---|
| 1 | Extract TTFWCore; protocol schema + fixtures; tokens.json → Swift/CSS | iOS builds on the package; CI contract tests green |
| 2 | macOS target (split view, keyboard deciding, menu bar capture) | Two-platform demo against one relay |
| 3 | Web MVP: feed + decide + reply + channels, web OAuth + GitHub proxy | Decision loop closes in a browser |
| 4 | Web Push + PWA install; session JWTs; offline read cache | Notification parity; auth hardened |
| 5 | Desktop workbench polish (3-pane provenance, ⌘K command palette on web) | "Summary next to source" on every large screen |

## 8. Anti-goals

- No logic forks per platform — if a platform "needs different routing", fix the relay
- No shared-UI framework (Flutter/RN/Compose MP) — the thin-client bet makes native shells cheap; shared UI would trade each platform's best idiom for a third codebase
- No web-only features — anything new lands in the relay first, then renders everywhere
