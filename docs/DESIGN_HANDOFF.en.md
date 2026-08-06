# TikTok for Work — Project Overview & Design Handoff

Last updated: 2026-08-06
Audience: the designer who will build this product's UI/UX
Japanese version: [DESIGN_HANDOFF.ja.md](./DESIGN_HANDOFF.ja.md)

---

> ## ⚠️ Read this first
>
> **The current UI is a mockup. Nothing about the design system or the quality bar is settled yet.**
>
> The colors, sizes, spacing, and components described in this document are a **report of
> what the code does today** — they are **not a spec to follow**.
>
> - What's on screen now is scaffolding put there to make the product work
> - Every value and every component is fair game to replace
> - **Defining the design system from scratch is the work ahead**
>
> The point of this document is to hand over what exists and where to change it — not to
> ask you to ratify the current look.

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

### The core loop (the heart of the product)

```
The sender gives their AI a natural-language instruction
   ↓  "Tell your AI" input sheet
The AI infers intent, recipient, priority, and card type (org graph + LLM)
   ↓  Draft Review sheet — confirm before sending
The card lands in the recipient's feed in real time (WebSocket)
   ↓  Vertical paging feed, one card at a time
They decide (Create issue / Decline / Revise / Delegate)
   ↓  Swipe or button
A GitHub Issue is created, and the result flows back to the sender
```

**The key design point**: this one loop must run without friction. It's the center of the experience; everything else exists to support it.

### Organization and members

The relay server owns the member roster and it grows from inside the app. **There is no fixed cast of placeholder users.**

Founding members:

| Member | Role |
|---|---|
| Toru | CEO |
| Gota | PM |

- Members are added in-app via **Organization → Add member** (name / role / GitHub username / who they report to)
- A new member syncs to every device instantly and is **immediately routable by the AI**
- Each member automatically gets their own AI agent (`<Name>'s AI`)
- Routing matches work to **roles**, not to specific people (design work → a designer, engineering → an engineer, budget/hiring → the CEO). Onboarding someone takes no code change

---

## 2. Current status

| Area | State | Notes |
|---|---|---|
| Core loop (instruct → card → decide → GitHub) | Working | Verified on simulator/device |
| AI routing | Implemented | Via OpenRouter; keyword fallback when no key is set |
| Realtime sync | Implemented | localhost WebSocket relay (`server/`) |
| GitHub integration | Implemented | OAuth login → repo picker → Issues API |
| Organization & members | Implemented | Server-owned roster, in-app add, synced to all clients |
| Org graph visualization | Barely started | The data exists; the screen is just a list |
| **UI / design system** | **Mockup stage** | **To be built. Everything current is provisional** |
| Roster persistence | Not handled | Restarting the relay resets to the founding members |
| Distributable build | Not started | TestFlight / installable build is future work |

---

## 3. Screen inventory (information architecture)

The surface count is deliberately small: **one feed plus modals.** This structure is also open to revision.

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

Overlays:
- `ProcessingOverlay` — full-screen dim with a spinner and a progress message
- `DraftingBanner` — slides in from the top: "Drafting decision card…"

### Structure of the main screens (as built)

**AuthView (sign in)**
Left-aligned vertical stack: logo → wordmark → "Decisions, not messages". GitHub sign-in → repository picker → "You" to pick yourself in the organization. A pinned Continue button at the bottom.

**FeedView (home)**
Cards fill the container height with vertical paging scroll. With zero cards, a three-line empty state sits centered.

**DecisionCardView (the decision card) — the most important component**
Current element order:
1. Meta row — card type `·` priority `·` relative time
2. Sender — "From <name>" plus the agent path (`<Name>'s AI → <Name>'s AI`)
3. **Why you box** — routing reason
4. Title
5. Summary
6. Context (`label: value · label: value`)
7. "View details" link
8. GitHub Issue link (once created)
9. Status label (when not pending)
10. Action block — Create issue / Decline · Revise · Delegate / swipe hint

This ordering and weighting is **the main battleground for redesign**.

**OrgGraphView (organization)**
Sectioned lists for People / Agents / Teams plus relationships in monospace. It's generated from the roster, so it grows as members are added. **It does not read as a graph at all.**

---

## 4. What's currently implemented (**provisional — not a spec**)

> These numbers are a snapshot of what the code says today. They weren't arrived at through
> design reasoning, and they are **expected to be replaced wholesale**.
> They live in `TikTokForWork/Design/Theme.swift`.

### 4.1 Color (provisional)

Dark mode only right now (`preferredColorScheme(.dark)` is pinned). No light mode.

| Token | Current value | Use |
|---|---|---|
| `background` | `#000000` | App canvas |
| `surface` | `#0C0C0E` | Sheet backgrounds |
| `surfaceRaised` | `#161618` | Inputs, chips, the Why-you box, list rows |
| `textPrimary` | `#F4F4F5` | Titles, primary text |
| `textSecondary` | `#A1A1AA` | Summaries, supporting text |
| `textTertiary` | `#71717A` | Metadata, placeholders, disabled states |
| `accent` | `#5E6AD2` | Links, selection, the accent bar |
| `approve` | `#4ADE80` | Connection indicator, approval states |
| `issueGreen` | `#238636` | Create-issue button |
| `reject` | `#F87171` | Decline, urgent priority, errors |

Colors hardcoded outside the theme: `#FBBF24` (priority High / deadline), `#38BDF8` (channel).

### 4.2 Typography (provisional)

SF Pro (`Font.system`). Currently only `.regular` and `.medium` — no bold anywhere.

| Token | Size | Weight |
|---|---|---|
| `title` | 26 | medium |
| `body` | 17 | regular |
| `caption` | 13 | regular |
| `label` | 12 | regular |
| `micro` | 11 | regular |

There are 10+ sizes hardcoded outside this scale (32 / 16 / 15 / 14 / 13 mono / 12 mono / 10 mono / 9). **The system isn't closed today.**

### 4.3 Spacing / radius (provisional)

4pt grid: `xs` 4 / `sm` 8 / `md` 16 / `lg` 24 / `xl` 32 / `xxl` 48 / `screen` 24
Radius: `sm` 6 (chips) / `md` 10 (buttons, inputs) / `sheet` 14 (defined, unused)

### 4.4 Components that exist today

All in `TikTokForWork/Design/Components.swift`.

| Component | Current state |
|---|---|
| `PrimaryButton` | 48pt tall, light fill with dark label |
| `GitHubPrimaryButton` | 48pt tall, GitHub green with white label and mark |
| `SecondaryAction` | 40pt tall, text only |
| `ComposeBar` | 48pt tall, "Tell your AI" |
| `PageDots` | Active dot is a wider capsule |
| `PrioritySlider` | Four segments — Low/Med/High/Now |
| `LabelChip` | Capsule chip |
| `ToolCallChip` | Shows an AI tool call |
| `ContextInsightView` | Parses and renders the context string |
| `AppLogo` | Three stacked cards with an accent bar |
| `ProcessingOverlay` / `DraftingBanner` | The two busy treatments |

### 4.5 Context Insight (automatic meaning for context strings)

The AI returns `context` as `label: value · label: value`. There is a parser that classifies each segment (deadline / metric / scope / channel / action / link / routing / general) and **already defines an icon and tint for each kind**.

**None of it is drawn today** — the view renders two text columns only. The machinery works, so it's available to any design that wants it.

---

## 5. Interaction & motion (provisional)

Current values. The approach itself is open to revision.

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

## 6. Copy

### Voice (current direction)

- "Tell your AI," not "Send message"
- "Decision recorded," not "Message sent"
- Sentence case. Short. No filler
- Tagline: **"Decisions, not messages"**

### Key strings today

| Where | Copy |
|---|---|
| Auth tagline | Decisions, not messages |
| ComposeBar | Tell your AI |
| Auth identity picker | Your AI works on your behalf and receives cards addressed to you. |
| Add member | New members get their own AI agent and can receive decision cards immediately. |
| AI input helper | Your AI drafts a decision card in the background — keep scrolling while it works. |
| Card swipe hint | Swipe right to create issue · left to decline |
| Revise helper | What should change before this becomes a GitHub issue? |
| Empty state | Tell your AI what you need / Decisions will show up here |

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

## 7. Open decisions

What is genuinely undecided, roughly by weight.

### Large

1. **Define the design system** — color, type, spacing, components, decided with actual reasoning. The current values aren't even a starting point; they're placeholders.
2. **Set the quality bar** — how far to build, and what counts as done. Today's UI is the minimum needed to make the mechanics work.
3. **Information design of the Decision Card** — the center of the product. What is seen first, what collapses, how priority / sender / routing reason are weighted.
4. **Visualize the org graph** — the data (people, AIs, teams, reporting lines) is all there, but the screen is a list. This is where the product's claim — "you can see structurally who should decide" — could actually land.
5. **Design for a growing roster** — everything currently reads as a two-person org. The feed, the delegate picker, the org screen, and the page dots all need a design that holds at 10 and 50 people.

### Medium

6. **Identity treatment** — no avatars; the sender is just "From <name>" as text. How each member's AI agent is represented is also undecided.
7. **Accessibility policy** — font sizes are all fixed (no Dynamic Type), VoiceOver labels are nearly absent, and some tap targets are under 44pt. Decide what to guarantee.
8. **Light/dark policy** — dark-pinned today. Supporting both means revisiting the tokens.
9. **Language** — English only, no localization layer. Decide early if a Japanese UI is needed.
10. **Error and empty states** — errors use the stock system alert; there's only one empty state.

### Small

11. Whether to actually use the Context Insight icons and tints
12. Whether to use or delete `Radius.sheet` (14)
13. Whether to absorb the two hardcoded colors and stray font sizes into tokens

---

## 8. Setup (getting it running)

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

### Running on two devices

1. Device A → sign in with GitHub → pick a repo → pick Toru as yourself
2. Device B → sign in the same way → pick Gota
3. On Toru, tap "Tell your AI" and type a natural-language instruction
4. The card appears on Gota's screen in real time (green dot in the top bar = connected)
5. Gota taps Create issue → a GitHub Issue is opened and the result flows back to Toru

To add teammates, use **Organization → Add member** on either device — it lands on both immediately.

### SwiftUI previews

Previews exist for `RootView` / `FeedView` / `AuthView` / `OrgGraphView` / `AddMemberSheet` / `AIInputSheet` / `AppLogo` / `DecisionCardView` (with real data). Fastest way to look at UI in isolation.

---

## 9. File map (where to make changes)

```
TikTokForWork/
├─ Design/                     ← tokens and shared parts. Start here
│  ├─ Theme.swift                color / type / spacing / radius (provisional values)
│  ├─ Components.swift           buttons, chips, ComposeBar, PrioritySlider, ContextInsight
│  ├─ ProcessingOverlay.swift    blocking overlay + drafting banner
│  ├─ AppLogo.swift              logo
│  ├─ Haptics.swift              the two haptic types
│  └─ DateFormatting.swift       relative timestamps
├─ Features/
│  ├─ Auth/AuthView.swift        sign-in + identity picker
│  ├─ Feed/
│  │  ├─ FeedView.swift          home (top bar / bottom chrome / sheet plumbing)
│  │  ├─ DecisionCardView.swift  ★ the card itself, including swipe handling
│  │  ├─ AIInputSheet.swift      AI input + DraftReviewSheet
│  │  ├─ CardDetailSheet.swift   card detail
│  │  ├─ ReviseSheet.swift       revision request
│  │  ├─ DelegatePickerSheet.swift delegate picker
│  │  └─ UserSwitcherSheet.swift switch who you are
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

---

## 10. Related docs

- [README.md](../README.md) — product overview, setup, architecture
- [PROGRESS.md](../PROGRESS.md) — implementation status
- [design.md](../design.md) — early design notes (**drifted from the code; reference only**)
- [server/README.md](../server/README.md) — relay server, OAuth, roster API, WebSocket protocol
