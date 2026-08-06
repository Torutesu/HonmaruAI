# TikTok for Work — Project Overview & Design Handoff

Last updated: 2026-08-06
Audience: the designer taking over UI/UX for this product
Japanese version: [DESIGN_HANDOFF.ja.md](./DESIGN_HANDOFF.ja.md)

---

## 1. Product overview

### In one line

**An AI-native work platform that delivers decisions, not messages.**

Instead of humans talking to each other through channels and threads, **every person talks only to their own AI**. The AIs decide who a request belongs to using the org graph, and the recipient receives a **Decision Card** — the request restructured into something they can act on immediately.

### The problems we're solving

| Problem with existing tools | Our answer |
|---|---|
| Channels multiply endlessly | There is no channel concept at all |
| Notification overload buries important things | Only "the card you must decide right now," one at a time |
| Nobody knows who's watching what | The AI routes using the org graph and shows its reasoning |
| Nobody knows who should decide | Every card carries a "Why you" explanation |
| Decisions get lost in conversation | Decisions are recorded automatically as GitHub Issues |
| The same thing gets explained repeatedly | The AI restructures per the recipient's role |

### The core loop (the heart of the product)

```
Alice gives her AI a natural-language instruction
   ↓  "Tell your AI" input sheet
The AI infers intent, recipient, priority, and card type (org graph + LLM)
   ↓  Draft Review sheet — confirm before sending
The card lands in Bob's feed in real time (WebSocket)
   ↓  Vertical paging feed, one card at a time
Bob decides (Create issue / Decline / Revise / Delegate)
   ↓  Swipe or button
A GitHub Issue is created, and the result flows back to Alice
```

**The key design point**: this one loop must run without friction. Quality of this loop has been prioritized over breadth of features throughout.

### Demo cast

The in-app demo reproduces a fixed four-person team.

| User | Role | Org relationships |
|---|---|---|
| Alice | Product Manager | Manages Bob / approval authority on Onboarding v2 |
| Bob | Engineer | Core Team, Engineering |
| Carol | Designer | Core Team, Design Team |
| Dana | Engineering Lead | Manages Bob / approval authority on Onboarding v2 |

---

## 2. Current status

| Area | State | Notes |
|---|---|---|
| Core loop (instruct → card → decide → GitHub) | Working | Verified on simulator/device |
| AI routing | Implemented | Via OpenRouter; keyword-based fallback when no key is set |
| Realtime sync | Implemented | localhost WebSocket relay (`server/`) |
| GitHub integration | Implemented | OAuth login → repo picker → Issues API |
| Org graph | UI implemented, data is fixed demo data | Rendered as a list, not a graph (see debt below) |
| Multi-user | Implemented | In-app user switch + two simulators side by side |
| Distributable build | Not started | TestFlight / installable build is future work |

---

## 3. Screen inventory (information architecture)

The surface count is deliberately small: **one feed plus modals.**

```
RootView                                 launch branch
├─ restoring indicator                   "Restoring session…"
├─ AuthView                              signed out
└─ FeedView                              home — the only persistent screen
   ├─ Top bar: user name + connection dot / page dots / ⋯ menu
   ├─ Card area: DecisionCardView, full-screen vertical paging
   ├─ Bottom: repository name + "Tell your AI" ComposeBar
   └─ Modals (all sheets)
      ├─ AIInputSheet          instruction input + priority
      ├─ DraftReviewSheet      review and send the AI's draft
      ├─ CardDetailSheet       detail (Why you / Context / Routing / GitHub)
      ├─ ReviseSheet           revision note input
      ├─ DelegatePickerSheet   pick a delegate
      ├─ UserSwitcherSheet     demo user switching
      └─ OrgGraphView          organization (People / Agents / Teams / Projects / Relationships)
```

Overlays:
- `ProcessingOverlay` — full-screen dim (black 55%) with a spinner and a progress message
- `DraftingBanner` — slides in from the top: "Drafting decision card…"

### Structure of the main screens

**AuthView (sign in)**
Left-aligned vertical stack: 56pt logo → 32pt/medium wordmark → "Decisions, not messages". Center holds the GitHub sign-in button (unauthenticated) or the repository picker (authenticated) plus a connected banner. A pinned Continue button sits at the bottom.

**FeedView (home)**
Pure black canvas. Each card fills the container height (`containerRelativeFrame(.vertical)`) with vertical paging scroll; scroll indicators hidden. With zero cards, a three-line empty state sits centered.

**DecisionCardView (the decision card) — the most important component**
Top to bottom:
1. Meta row — card type `·` priority `·` relative time (trailing)
2. Sender — "From Bob" plus the agent path ("Bob's AI → Alice's AI")
3. **Why you box** — 2pt accent bar on the left, `surfaceRaised` fill, routing reason
4. Title, 26pt/medium
5. Summary, 17pt/regular (`textSecondary`)
6. Context (compact form: `label: value · label: value`)
7. "View details" link (accent)
8. GitHub Issue link (once created)
9. Status label (when not pending)
10. Action block — Create issue (GitHub green, 48pt) / Decline · Revise · Delegate (three equal text buttons) / swipe hint

**OrgGraphView (organization)**
Sectioned lists for People / Agents / Teams / Projects, followed by relationships printed in monospace (`Alice  manages  Bob`).

---

## 4. Design system

> **Important**: the source of truth in the codebase is `TikTokForWork/Design/Theme.swift`. The top-level `design.md` is the original proposal and its colors and sizes no longer match what shipped (see "Known debt"). **Treat Theme.swift as canonical.**

### 4.1 Color

Dark mode only — `preferredColorScheme(.dark)` is forced. No light mode.

| Token | Hex | Use |
|---|---|---|
| `background` | `#000000` | App canvas. Pure black (OLED-first) |
| `surface` | `#0C0C0E` | Sheet backgrounds |
| `surfaceRaised` | `#161618` | Inputs, chips, the Why-you box, list rows |
| `textPrimary` | `#F4F4F5` | Titles, primary text |
| `textSecondary` | `#A1A1AA` | Summaries, supporting text |
| `textTertiary` | `#71717A` | Metadata, placeholders, disabled states |
| `accent` | `#5E6AD2` | Links, selection, the accent bar. **One accent moment per screen** |
| `approve` | `#4ADE80` | Connection indicator, approval states |
| `issueGreen` | `#238636` | Create-issue button (matches GitHub's brand green) |
| `reject` | `#F87171` | Decline, urgent priority, errors |

Colors hardcoded in views and **not yet tokenized**:

| Hex | Where |
|---|---|
| `#FBBF24` | Priority High; the `deadline` context-insight kind |
| `#38BDF8` | The `channel` context-insight kind |

### 4.2 Typography

SF Pro (`Font.system`). **No bold.** Only `.regular` and `.medium` — hierarchy comes from size and color, never weight.

| Token | Size | Weight | Use |
|---|---|---|---|
| `title` | 26 | medium | Card title, Draft Review title |
| `body` | 17 | regular | Summary, body copy, text input |
| `caption` | 13 | regular | Supporting text, meta rows, detail values |
| `label` | 12 | regular | Section headers, chips, status |
| `micro` | 11 | regular | Timestamps, hints, smallest meta |

Sizes hardcoded outside the scale (**needs cleanup**): 32/medium (auth wordmark), 16/medium (PrimaryButton), 16/semibold (GitHubPrimaryButton), 15/medium (top-bar user name, UserSwitcher), 15/regular (org node labels), 14 (SecondaryAction), 13 monospaced (org relationships), 12 monospaced (connected repo), 10 monospaced (footer repo name), 9/semibold (chevron).

### 4.3 Spacing

4pt grid.

| Token | Value |
|---|---|
| `xs` | 4 |
| `sm` | 8 |
| `md` | 16 |
| `lg` | 24 |
| `xl` | 32 |
| `xxl` | 48 |
| `screen` | 24 (horizontal screen margin) |

### 4.4 Radius

| Token | Value | Use |
|---|---|---|
| `sm` | 6 | Chips, Why-you box, swipe hint labels |
| `md` | 10 | Buttons, inputs, list rows |
| `sheet` | 14 | Sheets (defined but currently unused — system default wins) |

### 4.5 Component catalog

All in `TikTokForWork/Design/Components.swift` (`AppLogo` and `ProcessingOverlay` live in their own files).

| Component | Description |
|---|---|
| `PrimaryButton` | 48pt tall, `textPrimary` fill with black label. Disabled: `surfaceRaised` + `textTertiary` |
| `GitHubPrimaryButton` | 48pt tall, `issueGreen` fill, white label, 16pt GitHub mark. The card's primary action |
| `SecondaryAction` | 40pt tall, text only, tintable (Decline uses `reject`) |
| `ComposeBar` | 48pt tall, `surfaceRaised`, sparkle icon + "Tell your AI" |
| `PageDots` | Active dot is a 16pt-wide white capsule, others 5pt. 5pt tall. 0.2s easeOut |
| `PrioritySlider` | Four segments — Low/Med/High/Now. Active bar takes the priority color, label goes `textPrimary` |
| `LabelChip` | Capsule, `surfaceRaised`, micro type |
| `ToolCallChip` | Shows an AI tool call: accent icon + label + detail |
| `ContextInsightView` | Parses and renders the context string (see below) |
| `AppLogo` | The `AppMark` asset — three stacked cards with an accent bar |
| `ProcessingOverlay` | Black 55% full-screen dim plus a `surfaceRaised` spinner pill |
| `DraftingBanner` | Inline top banner with a 0.5pt bottom rule |

### 4.6 Context Insight (automatic meaning for context strings)

The AI returns `context` as `label: value · label: value`. This system parses it and assigns an icon and tint per kind. On the card it renders compact (single line); in the detail sheet it becomes two columns (72pt label + value).

| Kind | Icon | Tint | Trigger words |
|---|---|---|---|
| deadline | `calendar` | `#FBBF24` | deadline, due, friday, tomorrow, eod … |
| metric | `chart.line.uptrend.xyaxis` | `reject` | %, p95, latency, regression … |
| scope | `square.stack.3d.up` | `accent` | production, staging, scope … |
| channel | `antenna.radiowaves.left.and.right` | `#38BDF8` | channel |
| action | `bolt.fill` | `approve` | hotfix, branch, deploy, fix … |
| link | `link` | `accent` | http, github.com |
| routing | `arrow.triangle.branch` | `textSecondary` | routed from … |
| general | `sparkle` | `textTertiary` | everything else |

> **Note**: the icons and tints are defined but **`ContextInsightView` does not currently draw them** even in the non-compact form — it renders two text columns only. This is unclaimed design headroom.

---

## 5. Interaction & motion

**Principle: fast and functional. No decorative animation.**

| Target | Spec |
|---|---|
| Feed paging | `.scrollTargetBehavior(.paging)` — one swipe, one card, system physics |
| Card swipe detection | 20pt minimum drag, **96pt** commit threshold. Only fires when horizontal travel exceeds vertical |
| Swipe right | Create issue (success haptic) |
| Swipe left | Decline (light haptic) |
| Swipe hint | Appears past 24pt of drag; opacity scales as `travel / 96` |
| Drag release | easeOut 0.18s |
| Priority change | easeOut 0.15s + light haptic |
| Page dots | easeOut 0.2s |
| Card list refresh | easeOut 0.2s |
| Auto-advance after a decision | easeOut 0.25s |
| Auth ↔ Feed transition | easeOut 0.2s |
| DraftingBanner | Slide from top edge + fade |

Haptics: only two — `Haptics.light()` (button taps, Decline, priority change) and `Haptics.success()` (issue created, delegated, decision committed).

**Note the two distinct busy states:**
- AI drafting → **non-blocking**. Only the top banner shows; the feed stays interactive ("keep scrolling while it works")
- Committing actions (GitHub sync, etc.) → **blocking**. `ProcessingOverlay` covers the screen

---

## 6. Copy rules

### Voice

- "Tell your AI," not "Send message"
- "Decision recorded," not "Message sent"
- Sentence case. Short. No filler
- Product tagline: **"Decisions, not messages"**

### Existing key strings

| Where | Copy |
|---|---|
| Auth tagline | Decisions, not messages |
| ComposeBar | Tell your AI |
| AI input helper (AI on) | Your AI drafts a decision card in the background — keep scrolling while it works. |
| AI input helper (offline) | Offline mode — local routing with your priority setting. |
| AI input placeholder | Ask Bob to review the onboarding PR before Friday |
| AI input submit | Draft in background / Draft card |
| Draft Review submit | Send decision card |
| Card swipe hint | Swipe right to create issue · left to decline |
| Revise helper | What should change before this becomes a GitHub issue? |
| Empty state | Tell your AI what you need / Decisions will show up here / Use Tell your AI below to route one |
| Launching | Restoring session… |
| Drafting | Drafting decision card… |

### Status display names (user-facing)

Deliberately different from the internal state names.

| Internal state | Displayed as |
|---|---|
| `pending` | Pending |
| `approved` | Issue created |
| `rejected` | Declined |
| `revised` | Revision requested |
| `delegated` | Delegated |
| `completed` | Closed on GitHub |

Card types: Approval / Delegation / **Update** (internally `notification`) / Task / Revision

### Constraints on AI-generated copy (enforced by the server prompt)

Card body text is written by the LLM. Size your layouts against these limits.

| Field | Constraint |
|---|---|
| title | **3–8 words**, action-oriented; filler like "tell Bob" is forbidden |
| summary | **1–2 sentences**, third person, what the recipient must decide or do |
| context | **2–4** `label: detail` segments joined by ` · ` |
| routingReason | **One sentence**: why this person owns the decision |
| labels | Optional GitHub-style labels (bug, infra, blocked …) |

Echoing the sender's exact wording is prohibited; the server detects echoes and rewrites them.

---

## 7. Known issues & design debt

Candidates to pick up after handoff, roughly in priority order.

### High

1. **`design.md` has drifted from the implementation** — it still holds the original proposal: background `#09090B` (shipped: `#000000`), 22pt title (shipped: 26pt), radii 0/4 (shipped: 6/10), and more. Either update it against `Theme.swift` or retire it and consolidate into this document.
2. **The org "graph" is effectively a list** — the brief calls for visualizing nodes (people/teams/AIs/projects) and edges (management, membership, approval authority). Today it's sectioned lists plus monospace relationship lines; the structure isn't legible. Biggest single opportunity here.
3. **Accessibility is unverified** — every font size is fixed, so nothing responds to Dynamic Type. VoiceOver labels exist only on `AppLogo` and "Refresh repositories". `textTertiary` (#71717A) on `background` (#000000) is roughly 4.8:1 contrast, which is thin for the 11–12pt text it's used on.
4. **Tap targets** — "View details" on the card is text-only and under 44pt. `SecondaryAction` is 40pt tall, below the 44pt minimum.

### Medium

5. **Escaped tokens** — hardcoded `#FBBF24` / `#38BDF8` plus 10+ font sizes outside the scale. The system isn't closed.
6. **Context Insight icons go unused** — kinds, icons, and tints are defined but never drawn. Implementing them would raise the information density of the detail sheet.
7. **`Radius.sheet` (14) is unused** — sheets defer to system defaults. Either use the token or delete it.
8. **PageDots grow with card count** — past ~10 cards the top bar breaks. Needs a cap and an overflow treatment.
9. **English only** — no localization layer. Worth considering a Japanese UI given the demo audience.
10. **No avatars or identity treatment** — the sender is just "From Bob" as text. Recognition of who sent a card could be much stronger.

### Low

11. **No light mode** — `preferredColorScheme(.dark)` is pinned. Supporting it would mean revisiting the token design, since everything is built on pure black.
12. **Dead code in `AuthView`** — an unused `fieldSection` helper remains.
13. **Errors use the system alert** — feed errors surface through a stock `.alert`, which doesn't match the product's quiet tone.
14. **Only one empty state** — "you've cleared everything" and "nothing has arrived yet" look identical.

---

## 8. Designer setup (getting it running)

Even for design review you need GitHub auth and the relay server running.

### Requirements

- macOS + Xcode 16 or later
- Node.js (for the relay server)
- [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`)
- A GitHub account

### Steps

```bash
# 1) Start the relay server
cd server
cp .env.example .env
#   fill in GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / OPENROUTER_API_KEY
npm install
npm start          # http://127.0.0.1:8080

# 2) Generate and open the Xcode project
cd ..
xcodegen generate
open TikTokForWork.xcodeproj
```

`server/README.md` covers creating the GitHub OAuth app (callback URL: `tiktokforwork://oauth/callback`).

### Two-simulator demo (to see inter-AI communication)

1. Simulator A → sign in with GitHub → pick a repo → enter as Alice
2. Simulator B → sign in the same way → switch user to Bob
3. On Alice, tap "Tell your AI" and type a natural-language instruction
4. The card appears on Bob's screen in real time (green dot in the top bar = connected)
5. Bob taps Create issue → a GitHub Issue is opened and the result flows back to Alice

### SwiftUI previews

Previews exist for the following — fastest way to look at UI in isolation:

- `RootView` / `FeedView` / `AuthView` / `OrgGraphView` / `AIInputSheet` / `AppLogo`
- `DecisionCardView` — includes a populated preview (an urgent card)

---

## 9. File map (where to make changes)

```
TikTokForWork/
├─ Design/                     ← tokens and shared parts. Start here
│  ├─ Theme.swift                color / type / spacing / radius (canonical)
│  ├─ Components.swift           buttons, chips, ComposeBar, PrioritySlider, ContextInsight
│  ├─ ProcessingOverlay.swift    blocking overlay + drafting banner
│  ├─ AppLogo.swift              logo
│  ├─ Haptics.swift              the two haptic types
│  └─ DateFormatting.swift       relative timestamps
├─ Features/
│  ├─ Auth/AuthView.swift        sign-in screen
│  ├─ Feed/
│  │  ├─ FeedView.swift          home (top bar / bottom chrome / sheet plumbing)
│  │  ├─ DecisionCardView.swift  ★ the card itself, including swipe handling
│  │  ├─ AIInputSheet.swift      AI input + DraftReviewSheet
│  │  ├─ CardDetailSheet.swift   card detail
│  │  ├─ ReviseSheet.swift       revision request
│  │  ├─ DelegatePickerSheet.swift delegate picker
│  │  └─ UserSwitcherSheet.swift user switching
│  └─ Org/OrgGraphView.swift     organization screen
├─ Models/                      card / org / user types (display names live here too)
├─ Data/DemoData.swift          the four demo users and the org graph
├─ ViewModels/FeedViewModel.swift feed state (progress message strings live here)
└─ Assets.xcassets/             app icon, logo, GitHub mark (SVG)

server/
├─ agentTools.js                ★ the AI prompt and card generation constraints (copy length rules)
└─ index.js                     WebSocket relay + OAuth + AI routing
```

**To change copy**: static UI strings are inline in each view file. Status and type display names are in `Models/DecisionCard.swift`. Progress messages are in `ViewModels/FeedViewModel.swift`. Instructions for AI-written copy are in `server/agentTools.js`.

---

## 10. Recommended next actions

1. **Update or retire `design.md`** — killing the duplicate source of truth comes first, so nobody new works from stale values.
2. **Design the org graph properly** — today's weakest screen and simultaneously the one that best expresses the product's differentiator ("you can see structurally who should decide").
3. **Do an accessibility pass** — Dynamic Type, 44pt tap targets, contrast re-check, VoiceOver labels.
4. **Close the token system** — absorb the two hardcoded colors and the stray font sizes into `Theme`.
5. **Revisit card information density** — put the Context Insight icons to work, give the sender a real identity treatment, widen the visual gap between priority levels.

---

## 11. Related docs

- [README.md](../README.md) — product overview, setup, architecture
- [PROGRESS.md](../PROGRESS.md) — implementation checklist
- [design.md](../design.md) — original design direction (**values are stale; Theme.swift is canonical**)
- [server/README.md](../server/README.md) — relay server, OAuth, WebSocket protocol
