# The 3-Second Value & Onboarding Design

## The 3-second value

> **Open the feed, and the decision you need to make is already there — clear it in one swipe.**

The product's promise is *decisions, not messages*. The feed delivers that
promise (seeded, triaged cards on first entry), and onboarding's job is to make
sure the user arrives at that feed **understanding what they're looking at,
signed in, and knowing exactly what one swipe means.**

## Onboarding philosophy: more screens, zero dead screens

Onboarding is deliberately a guided, multi-screen flow. A cold drop into a novel
paradigm ("you never message people; AIs route decisions") wastes the first
session on confusion. But every added screen must earn its place — each one
either *shows value*, *teaches by doing*, or *completes registration*. Nothing
is a static slide for its own sake.

The order is the order of persuasion: **value → mechanism → hands-on proof →
sign-in → identity.** Sign-in is asked for only *after* the product has
demonstrated itself — the moment the "approvals become GitHub Issues" pitch is
credible.

## The five screens

| # | Screen | Job | Why it exists |
|---|--------|-----|---------------|
| 1 | **Welcome** | Value | "Decisions, not messages" — the one-line promise, before anything is asked of the user. |
| 2 | **How it works** | Mechanism | The routing chain (You → Your AI → Dana's AI → Dana) as a visual. This is the paradigm shift; it needs its own screen or the feed reads as a weird chat app. |
| 3 | **Try it** | Hands-on proof | A real Decision Card the user must actually swipe. The core gesture is *performed*, not read about — swiping the card is what advances the flow. |
| 4 | **Sign in with GitHub** | Registration | OAuth + repository pick, placed after the value is proven. Skippable ("connect later from the feed") so a missing relay server never bricks the demo — the feed re-offers the connection contextually after the first approval. |
| 5 | **Who are you?** | Identity | The one question a multi-user product must ask: it decides which decisions you see. Persona rows, Alice marked "Start here", one tap to enter. |

Progress dots, back navigation, and a consistent title/subtitle rhythm keep the
flow legible; the whole path is ~5 taps + 1 swipe.

## After onboarding: the first 10 seconds of the feed

| Time | What happens | Design requirement it forces |
|---|---|---|
| 0s | Persona tapped → feed appears | Session activation must not block on network (relay connect falls back to local instantly). |
| 1–3s | Cards stream in, staggered ~450ms apart, each with an "X's AI → Your AI" routing line | Seeded first-session cards (`DemoData.seedCards`). A "Your AI triaged 3 decisions for you" note lands the story; a triage state (never a blank feed) covers the gap. |
| 3s | The flagship card is fully readable: urgent, from a teammate's AI, with a routing reason | Seed content is written as decisions: metric, deadline, action, org-graph reason on every card. |
| ~8s | First swipe right → approved. Haptic, status, auto-advance | The gesture was already learned on screen 3. If GitHub was connected on screen 4 this creates a real Issue; if skipped, it resolves locally and the app offers the connection at that exact moment. |

## Principles

1. **Teach by doing.** The only tutorial screen is one the user operates. The
   seeded feed then reinforces with real cards.
2. **Value before credentials.** GitHub sign-in sits at position 4, not 1 —
   after the pitch, before the feed. And it's skippable, because the feed can
   re-ask contextually (post-first-approval sheet, `Local mode · Connect GitHub`
   chip, account menu).
3. **Identity is the last gate.** "Who are you?" is the only question whose
   answer changes what the feed shows, so it sits directly before the feed.
4. **Never block on infrastructure.** Relay down → local seeded feed, fully
   interactive. Relay up → seeds publish to the relay so a second simulator
   (Bob) shares state. Sign-in failure → skip path keeps the flow alive.

## The funnel, before vs after

| Step | Before | After |
|---|---|---|
| First screen | GitHub OAuth wall (requires localhost server + OAuth app) | Value screen; OAuth at step 4 of 5, skippable |
| Concept teaching | None (dropped into empty feed) | Mechanism screen + interactive swipe demo |
| First feed | Empty ("Tell your AI what you need") | 3 triaged decisions arriving |
| First approve | Fails without GitHub | Succeeds (Issue if connected, local otherwise → contextual connect offer) |
| Replayability | — | Sign out resets all first-run flags |

## Implementation map

- `Features/Onboarding/OnboardingView.swift` — five-step guided flow
  (welcome / routing / swipe demo / GitHub / persona)
- `Features/Onboarding/OnboardingSwipeDemo.swift` — interactive tutorial card
- `Data/DemoData.swift` (`seedCards`) — per-persona triaged decisions
- `Services/DecisionCardService.swift` — staggered seeding, empty-snapshot merge,
  GitHub-optional resolve/delegate
- `Features/Auth/ConnectGitHubSheet.swift` — in-feed contextual GitHub connection
  for users who skipped step 4
- `App/AppState.swift` — session restore without GitHub; persona persisted in Keychain
