# TikTok for Work — Project Overview & Design Handoff

Last updated: 2026-08-07
Audience: the designer who will build this product's UI/UX
Japanese version: [DESIGN_HANDOFF.ja.md](./DESIGN_HANDOFF.ja.md)

---

> ## ⚠️ Read this first (two things)
>
> ### 1. The UI is not settled
>
> **The current UI is a mockup. Nothing about the design system or the quality bar is decided yet.**
> The colors, sizes, and spacing in this document are a **report of what the code does today** —
> they are **not a spec to follow**. Defining the design system from scratch is the work ahead.
>
> ### 2. Six branches are running in parallel, with three conflicting design directions
>
> **Nothing has been merged to `main`.** Development is happening across six branches, and
> **three mutually incompatible design directions exist simultaneously.**
> **The first job is deciding which one to adopt.** See §3.

---

## 1. Product overview

### In one line

**An AI-native work platform that delivers decisions, not messages.**

Instead of humans talking to each other through channels and threads, **every person talks only to their own AI**. The AIs decide who a request belongs to using the organization's structure, and the recipient receives a **Decision Card** — the request restructured into something they can act on immediately.

### The problems we're solving

| Problem with existing tools | Our answer |
|---|---|
| Channels multiply endlessly | There is no channel concept at all |
| Notification overload buries important things | Only "the card you must decide right now," one at a time |
| Nobody knows who's watching what | The AI routes using the org graph and shows its reasoning |
| Nobody knows who should decide | Every card carries a "Why you" explanation |
| Decisions get lost in conversation | Decisions are recorded automatically as GitHub Issues |
| The same thing gets explained repeatedly | The AI restructures per the recipient's role |

### The core loop (unchanged across every branch)

```
The sender gives their AI a natural-language instruction
   ↓  "Tell your AI"
The AI infers intent, recipient, priority, and card type (org graph + LLM)
   ↓  Review the draft before it sends
The card lands in the recipient's feed in real time
   ↓  Vertical paging feed, one card at a time
They decide (approve / decline / request revision / delegate)
   ↓  Swipe or button
A GitHub Issue is created, and the result flows back to the sender
```

**No branch has changed this.** It's the center of the experience; everything else supports it.

---

## 2. Organization and members

The founding members are real people:

| Member | Role |
|---|---|
| Toru | CEO |
| Gota | PM |

- Members are added in-app (name / role / GitHub username / who they report to)
- A new member syncs to every device instantly and is **immediately routable by the AI**
- Each member automatically gets their own AI agent (`<Name>'s AI`)
- Routing matches work to **roles**, not to specific people (design → a designer, engineering → an engineer, budget/hiring → the CEO). Onboarding someone takes no code change

> **Branch note**: this shape — server owns the roster, the app adds to it — was reached
> **independently** by three branches (`designer-project-handoff-docs`,
> `cross-platform-strategy`, `current-features-gaps`). Only `3sec-value-onboarding`
> still carries the old fixed cast of four placeholder users (Alice/Bob/Carol/Dana).

---

## 3. Repository situation map (★ the core of this document)

### 3.1 Branches

`main` = `a2d907b`. **None of these are merged.**

| Branch | Last update | Size | What's in it | Design direction |
|---|---|---|---|---|
| `cross-platform-strategy` | Aug 7 | 7 commits / 85 files | New backend (Hono + SQLite + zod schemas), web client, **classic chat mode** (channels + DMs, Feed/Chat toggle), @mentions, agent memory, SLA escalation, notifications. iOS becomes a thin client | **A. Current dark** (unchanged) |
| `designer-project-handoff-docs` (this branch) | Aug 7 | 2 commits / 30 files | Real member roster (Toru/Gota) + in-app member management, role-based routing, this document | **A. Current dark** (unchanged) |
| `app-store-connect-cli` | Aug 6 | 1 commit / 7 files | `asc` CLI release pipeline (TestFlight, review submission) | — |
| `3sec-value-onboarding` | Aug 4 | 6 commits / 28 files | Five-screen onboarding (value → mechanism → hands-on → sign-in → identity), AG-UI protocol adoption | **B. Light "white marble"** |
| `honmaruai-revenuecat-sdk` | Aug 3 | 1 commit / 17 files | RevenueCat billing (Pro), paywall, routing quota | — |
| `current-features-gaps` | Aug 1 | **31 commits / 157 files** | The largest. Web client (React/Vite, PWA, Web Push, E2E), channels, Notion integration, autopilot, voice input, push notifications, settings, ledger view | **C. design v3 "calm"** |

### 3.2 The three design directions (**the biggest fork**)

| | **A. Current dark** | **B. Light "white marble"** | **C. design v3 "calm"** |
|---|---|---|---|
| **Where** | main / cross-platform / this branch | 3sec-value-onboarding | current-features-gaps |
| **Character** | Placeholder. No design reasoning behind it | ClickUp-style, high-contrast productivity | Quiet; color only ever carries meaning |
| **Background** | `#000000` | `#FFFFFF` (95% of every screen) | Adaptive `#FBFBFC` / `#0B0C0E` |
| **Surfaces** | `#0C0C0E` / `#161618` | `#F8F9FA` / `#E9EBF0` / `#EEEEEE` | Adaptive `#FFFFFF` / `#141518` |
| **Accent** | `#5E6AD2` | Violet `#6647F0` (badges only) + blue `#0091FF` (interactive) | Adaptive `#4F5BD5` / `#7C8CF8` |
| **Primary CTA** | Light fill, dark label | **Filled dark `#202020` pill** (never violet) | The accent color |
| **Title** | 26 / medium | Plus Jakarta Sans 650–800, −0.04em tracking at 48px+ | **21 / semibold** |
| **Body** | 17 | Inter | **15** |
| **Radius** | 6 / 10 | **buttons 9999 (pill)** / cards 12 / large 20 / inputs 9 | 6 / 8 / 12 / 16 |
| **Separation** | Background steps, no lines | **1px `#E8E8E8` borders** (elevation is borders, not shadows) | Spacing and weight |
| **Motion** | easeOut 0.15–0.25s | 0.45s `cubic-bezier(0.33,1,0.68,1)`, hovers 0.15s | easeOut family |
| **Light/dark** | Dark-pinned | Light-pinned | **System/Dark/Light switch** |
| **Spec doc** | None | `docs/design-system.md` (the most thorough) | Comments in Theme.swift, synced with `web/src/styles/tokens.css` |

**Worth knowing**
- **B** is the only one with a written design system, down to CSS tokens. It's the most finished
- **C** is the only one supporting both light and dark, and the only one syncing tokens between iOS and web. It's a third generation, built as a reaction to "v2 was too loud"
- **A** is just a starting point — nobody designed it on purpose
- **B and C are fundamentally incompatible** (white pill language vs adaptive tonal, Plus Jakarta Sans vs system font). **You cannot take both**

### 3.3 The architecture has also forked

| | **1. Client-driven** | **2. Server-driven (thin clients)** |
|---|---|---|
| Where | main / 3sec / this branch | cross-platform (`backend/`) / current-features-gaps (`server/` + `web/`) |
| Where logic lives | The Swift client builds cards, syncs GitHub, owns state transitions | The server owns all domain logic; clients send intent and render state |
| Protocol | Loose JSON | zod schemas (cross-platform) / AG-UI events (3sec) |
| Other platforms | iOS only | Web exists; designed for desktop/Android too |

**Design implication**: taking direction 2 means **iOS and web must share one design system** (C already syncs tokens across both). It stops being a single-surface design problem.

### 3.4 Other unintegrated features

Things that need design but sit in only one branch:

| Feature | Where | Design state |
|---|---|---|
| Onboarding (5 screens) | 3sec | Built in white marble |
| Chat mode (channels / DMs) | cross-platform, current-features-gaps | Built, still direction A |
| Billing / paywall | revenuecat | Built only |
| Settings screen | current-features-gaps | Built in design v3 |
| Notifications / SLA escalation | cross-platform, current-features-gaps | Built only |
| Voice input | current-features-gaps | Built only |
| Web client | cross-platform, current-features-gaps | Two different designs |

---

## 4. What the designer needs to decide first

In priority order. Items 1–3 block everything else.

1. **Pick a design direction — A, B, C, or start over**
   - Take B (white marble) → fastest, there's a spec. But light-only
   - Take C (design v3 calm) → light/dark, already synced with web. But the spec is only code comments
   - Start over → most freedom, but it means rewriting everything that exists
2. **Pick the base branch** — it brings both a design direction and an architecture. In practice this is also the direction-1-vs-2 choice
3. **Decide the platform scope** — iOS only, or web too. It changes how the design system must be built
4. **Information design of the Decision Card** — the center of the product. What is seen first, what collapses
5. **Visualize the org graph** — the data (people, AIs, teams, reporting lines) exists, but every branch renders it as a list. This is where the product's claim could actually land
6. **Design for a growing roster** — everything currently reads as a 2–4 person org. The feed, delegate picker, and org screen need to hold at 10 and 50 people
7. **Identity treatment** — no avatars; the sender is just "From <name>". How each member's AI agent is shown is also undecided
8. **Accessibility policy** — every branch uses fixed font sizes (no Dynamic Type), VoiceOver labels are nearly absent, and some tap targets are under 44pt
9. **Language** — every branch is English-only, with no localization layer

---

## 5. Screen inventory (this branch = direction A)

Other branches add screens on top of this (5 onboarding screens, settings, channels, notifications, paywall, …).

```
RootView                                 launch branch
├─ restoring indicator                   "Restoring session…"
├─ AuthView                              signed out
│  ├─ GitHub sign-in
│  ├─ repository picker
│  └─ "You" — pick yourself in the org / Add member
└─ FeedView                              home — the only persistent screen
   ├─ Top bar: user name + connection dot / page dots / ⋯ menu
   ├─ Card area: DecisionCardView, full-screen vertical paging
   ├─ Bottom: repository name + "Tell your AI" ComposeBar
   └─ Modals (all sheets)
      ├─ AIInputSheet          instruction input + priority
      ├─ DraftReviewSheet      review and send the AI's draft
      ├─ CardDetailSheet       detail (Why you / Context / Routing / GitHub)
      ├─ ReviseSheet           revision note input
      ├─ DelegatePickerSheet   pick a delegate from the roster
      ├─ UserSwitcherSheet     switch who you are + Add member
      ├─ OrgGraphView          organization (People / Agents / Teams / Relationships) + Add member
      └─ AddMemberSheet        add a member (name / role / GitHub / reports to)
```

Overlays: `ProcessingOverlay` (full-screen dim + spinner) / `DraftingBanner` (slides in from the top)

### Current element order on the Decision Card (**the main battleground**)

1. Meta row — card type `·` priority `·` relative time
2. Sender — "From <name>" plus the agent path (`<Name>'s AI → <Name>'s AI`)
3. **Why you box** — routing reason
4. Title
5. Summary
6. Context (`label: value · label: value`)
7. "View details" link
8. GitHub Issue link (once created)
9. Status label (when not pending)
10. Action block — approve / decline · revise · delegate / swipe hint

---

## 6. Interaction (direction A, as built)

| Target | Current |
|---|---|
| Feed paging | `.scrollTargetBehavior(.paging)` — one swipe, one card |
| Card swipe detection | 20pt minimum drag, 96pt commit threshold |
| Swipe right / left | Create issue / Decline |
| Swipe hint | Appears past 24pt of drag; opacity scales with travel |
| Animation | All easeOut, 0.15–0.25s |
| Haptics | `light` (taps, priority change) and `success` (committed actions) |

**One deliberate decision worth keeping**: there are two distinct busy states.
- AI drafting → **non-blocking**. Only a top banner; the feed stays interactive
- Committing actions (GitHub sync) → **blocking**. Full-screen overlay

---

## 7. Copy

### Voice (shared across branches)

- "Tell your AI," not "Send message"
- "Decision recorded," not "Message sent"
- Sentence case. Short. No filler
- Tagline: **"Decisions, not messages"**

### Status display names

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

Card body text is written by the LLM. **These limits are what layout sizing should be based on.**

| Field | Constraint |
|---|---|
| title | **3–8 words**, action-oriented |
| summary | **1–2 sentences**, third person, what the recipient must decide or do |
| context | **2–4** `label: detail` segments joined by ` · ` |
| routingReason | **One sentence**: why this person owns the decision |
| labels | Optional GitHub-style labels |

These constraints can themselves be changed for design reasons (`server/agentTools.js`).

---

## 8. Setup

### Requirements

- macOS + Xcode 16 or later / Node.js / [XcodeGen](https://github.com/yonaskolb/XcodeGen) (`brew install xcodegen`) / a GitHub account

### Steps (this branch)

```bash
# 1) Start the relay server
cd server
cp .env.example .env
#   fill in GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / OPENROUTER_API_KEY
npm install && npm start          # http://127.0.0.1:8080

# 2) Generate and open the Xcode project
cd .. && xcodegen generate && open TikTokForWork.xcodeproj
```

> Other branches set up differently. `cross-platform-strategy` uses `backend/`
> (Docker/Fly-ready) and `current-features-gaps` uses `server/` + `web/` — check
> their own READMEs.

### Running on two devices

1. Device A → sign in with GitHub → pick a repo → pick Toru as yourself
2. Device B → sign in the same way → pick Gota
3. On Toru, tap "Tell your AI" and type a natural-language instruction
4. The card appears on Gota's screen in real time (green dot in the top bar = connected)
5. Gota taps Create issue → a GitHub Issue is opened and the result flows back to Toru

To add teammates: **Organization → Add member**. It lands on both devices immediately.

---

## 9. File map (this branch)

```
TikTokForWork/
├─ Design/                     ← tokens and shared parts. Start here
│  ├─ Theme.swift                color / type / spacing / radius (provisional values)
│  ├─ Components.swift           buttons, chips, ComposeBar, PrioritySlider, ContextInsight
│  ├─ ProcessingOverlay.swift    blocking overlay + drafting banner
│  ├─ AppLogo.swift / Haptics.swift / DateFormatting.swift
├─ Features/
│  ├─ Auth/AuthView.swift        sign-in + identity picker
│  ├─ Feed/
│  │  ├─ FeedView.swift          home (top bar / bottom chrome / sheet plumbing)
│  │  ├─ DecisionCardView.swift  ★ the card itself, including swipe handling
│  │  ├─ AIInputSheet.swift      AI input + DraftReviewSheet
│  │  ├─ CardDetailSheet.swift / ReviseSheet.swift
│  │  ├─ DelegatePickerSheet.swift / UserSwitcherSheet.swift
│  └─ Org/
│     ├─ OrgGraphView.swift      organization screen
│     └─ AddMemberSheet.swift    add a member
├─ Models/                      card / org / user types (display names live here too)
├─ Data/OrgDirectory.swift      ★ the member roster — founding members and sync
├─ ViewModels/FeedViewModel.swift feed state (progress message strings live here)
└─ Assets.xcassets/             app icon, logo, GitHub mark (SVG)

server/
├─ members.js                   founding members (Toru / Gota) and id assignment
├─ agentTools.js                ★ the AI prompt and card generation constraints (copy length rules)
└─ index.js                     WebSocket relay + OAuth + roster API + AI routing
```

**To change copy**: static UI strings are inline in each view file. Status and type display names are in `Models/DecisionCard.swift`. Progress messages are in `ViewModels/FeedViewModel.swift`. Instructions for AI-written copy are in `server/agentTools.js`.

### Files worth reading on other branches

| What you want | Branch | Path |
|---|---|---|
| The white marble design system spec | `3sec-value-onboarding` | `docs/design-system.md` |
| Onboarding design thinking | `3sec-value-onboarding` | `onboarding.md` |
| AG-UI protocol design | `3sec-value-onboarding` | `docs/agui-protocol.md` |
| design v3 tokens and rationale | `current-features-gaps` | `TikTokForWork/Design/Theme.swift` (comments) / `web/src/styles/tokens.css` |
| Cross-platform planning | `current-features-gaps` | `docs/CROSS_PLATFORM.md` / `docs/WEB_PLAN.md` |
| Why the server-driven architecture | `cross-platform-strategy` | `backend/README.md` |
| Billing design | `honmaruai-revenuecat-sdk` | `docs/revenuecat.md` |
| Release procedure | `app-store-connect-cli` | `docs/app-store-release.md` |

---

## 10. Related docs

- [README.md](../README.md) — product overview, setup, architecture
- [PROGRESS.md](../PROGRESS.md) — implementation status
- [design.md](../design.md) — early design notes (**drifted from the code; reference only**)
- [server/README.md](../server/README.md) — relay server, OAuth, roster API, WebSocket protocol
