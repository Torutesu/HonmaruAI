# The 3-Second Value & Onboarding Design

## The 3-second value

> **Open the app, and the decision you need to make is already there — clear it in one swipe.**

Everything about the first-run experience is derived backwards from this sentence.
The product's promise is *decisions, not messages*. So the first thing a new user
sees must be a decision — not a login form, not a tutorial, not an empty feed.

### Why this and not something else

Candidates considered:

| Candidate hook | Why it loses |
|---|---|
| "Talk to your AI" (compose-first) | Requires the user to type before seeing value. Cold start with a blank input is the highest-friction pattern that exists. |
| "See the org graph" | Explains the system, doesn't demonstrate it. Understanding ≠ feeling. |
| "Sign in with GitHub, then…" | The value of GitHub sync only lands *after* you have a decision to sync. Auth before value inverts the funnel. |
| **"A decision is already waiting for you"** | Zero input required. The card format, the AI routing line, and the one-swipe resolution all demonstrate themselves in a single frame. |

## Working backwards: the first 10 seconds

| Time | What happens | Design requirement it forces |
|---|---|---|
| 0s | Cold open → one screen: headline + "Continue as" personas | No auth wall. No relay-server requirement. One tap max before the feed. |
| ~1s | Tap a persona → feed appears | Session activation must not block on network (relay connect falls back to local instantly). |
| 1–3s | Cards stream in, staggered ~450ms apart, each with an "X's AI → Your AI" routing line | Seeded first-session cards (`DemoData.seedCards`). Staggering makes the feed feel *alive* — your AI has been triaging while you were away — and a "Your AI triaged 3 decisions for you" note reinforces it. |
| 3s | The flagship card is fully readable: urgent, from a teammate's AI, with a reason ("You hold release approval for Onboarding v2") | Seed content is written as decisions, not lorem ipsum: metric, deadline, action, and an org-graph routing reason on every card. |
| ~8s | First swipe right → approved. Haptic, status, auto-advance to the next card | Approval must succeed **without** GitHub. Local-first resolution; sync is an upgrade, not a precondition. |

## Onboarding principles

1. **The product is the tutorial.** The seeded cards teach card anatomy, swiping,
   and AI routing by being real. No coach marks, no screenshot carousel.
2. **Identity before setup.** The only question worth asking upfront in a
   multi-user product is "who are you?" — it changes what the feed shows.
   One tap, no typing, Alice marked "Start here".
3. **Progressive disclosure of GitHub.** The auth wall was removed, not the
   auth. GitHub connects at the exact moment its value is self-evident: right
   after your first approval, the app offers "Connect GitHub and every approval
   becomes an Issue your team can track." Also reachable any time from the
   `Local mode · Connect GitHub` chip and the account menu.
4. **Never block on infrastructure.** Relay down → local feed, seeded and fully
   interactive. Relay up → the same seeds are published to the relay so a second
   simulator (Bob) sees the shared state. Reconnection merges rather than wipes.

## The funnel, before vs after

| Step | Before | After |
|---|---|---|
| First screen | GitHub OAuth (requires localhost server + OAuth app configured) | Persona pick, 1 tap |
| First feed | Empty ("Tell your AI what you need") | 3 triaged decisions arriving |
| Time to first value | Minutes (setup) → still empty | ~3 seconds |
| First approve | Fails without GitHub | Succeeds locally, then invites GitHub |
| GitHub connect | Precondition | Contextual one-tap upgrade, post-aha |

## Implementation map

- `Features/Onboarding/OnboardingView.swift` — one-tap entry
- `Data/DemoData.swift` (`seedCards`) — per-persona triaged decisions
- `Services/DecisionCardService.swift` — staggered seeding, empty-snapshot merge,
  GitHub-optional resolve/delegate
- `Features/Auth/ConnectGitHubSheet.swift` — contextual GitHub connection
  (post-first-approval / chip / menu), replaces the old blocking `AuthView`
- `App/AppState.swift` — session restore without GitHub; persona persisted in Keychain
- Sign out fully resets first-run flags so the demo can be replayed.
