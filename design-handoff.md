# Design handoff — Figma

**File:** https://www.figma.com/design/6gMGzJwY1bHStnIKEhxu9h
Team: Select (pro) · Last updated 2026-08-09

The file holds 23 screens from **two different sources**, and they do not agree with
each other. Every page is labelled with which one it came from.

| Source | Pages | What it is |
|---|---|---|
| **Code** | `01 · Core app`, `02 · Onboarding` | Mirrored from `claude/testflight-light` @ `9dc4b82` — what the app renders today |
| **Spec** | `03 · Onboarding v3`, plus the Reply card on `01` | Reconstructed from `docs/design-system.md` — designed, not built |

> `main` has not moved since 30 July and nothing has been merged into it. Nine branches
> are open; `claude/testflight-light` (8 Aug) is the newest and the only one carrying
> the white marble design system.

## Nothing on the spec pages was copied

`docs/design-system.md` points at
[Honmaru-AI-Mobile-App-UI-UX-Design](https://www.figma.com/design/ii8w8x7gvN3wp70vlszBSa),
which holds the real Onboarding v3 and Core App v3 sections. **That file cannot be read.**
It sits on a Figma Starter team and the MCP server refuses every call against it — the
same blocker recorded at the top of `docs/figma/classic-slack-rebuild.js`, still in force.

So the v3 pages were rebuilt from the screen names and the design system alone: the
names and the tokens are the spec, the layouts and the copy are new work. **Check them
against the original before treating them as the design.** Moving that file to a
Professional team (the URL and key do not change) would let the real thing be read, and
would also unblock the two stalled scripts in `docs/figma/`.

## The gap that matters

The two onboarding flows are not long and short versions of each other. Only **Welcome**
appears in both.

| | Ships (5 screens) | Onboarding v3 (12 screens) |
|---|---|---|
| Shape | An argument | A setup wizard |
| Steps | Welcome → how routing works → swipe a real card → GitHub (skippable) → persona | Welcome → create account → bring your own AI → call name → role → connect tools → scanning → your projects → who's who → house rules → ready → choose your plan |
| Assumes | Nothing beyond what is built | Accounts, BYO model key, tool scanning, an inferred org, per-rule autonomy, billing |

Building v3 means building all of that. Keeping the shipped flow means v3's twelve
screens stop being the design of record. Either is fine; drifting is not.

Core App v3 also specifies three card shapes — Decision, Choice and **Reply**. The code
has the first two. The Reply card on `01 · Core app` is reconstructed.

## Pages

| Page | Contents |
|------|----------|
| `00 · Read me` | Provenance, branch map, design-vs-code gap, real vs mocked, ranked open questions |
| `01 · Core app` | 6 screens — Decision / Choice / Reply cards, Classic, Capture, You |
| `02 · Onboarding` | 5 screens — the flow that ships (Japanese UI, SF Pro) |
| `03 · Onboarding v3` | 12 screens at 390×844 in Plus Jakarta Sans / Inter / Sometype Mono, per the spec |
| `04 · Components` | 13 components named after the SwiftUI structs |
| `05 · Tokens` | White marble palette, conic rainbow, type ramp, radius and spacing |

The v3 screens are in English: they are named in English in the spec, and the three
typefaces it specifies carry no CJK. The shipped app is Japanese — which is itself an
open question about when v3 was drawn.

## Tokens

`Tokens` (31 variables, single `Light` mode) mirrors `TikTokForWork/Design/Theme.swift`
plus the values the spec defines but Theme does not carry (`plaster`, `mint`, `onyx`).

Not variable-bound, deliberately: **translucent tints** (Figma discards paint opacity
when a colour variable is bound to a paint) and **the conic rainbow** (Figma cannot bind
a gradient).

## Open questions

Full list on `00 · Read me`. The ones needing a decision rather than polish:

1. Pick one of the three design directions — white marble, calm v3
   (`claude/current-features-gaps`, the only light/dark system with shared iOS+Web
   tokens), or the dark placeholder on `main`.
2. Ship v3's setup flow, or keep the five-screen one. They are different products.
3. **The design system's typefaces do not ship.** No font files, no `Font.custom` — the
   app renders SF Pro everywhere while the spec asks for Plus Jakarta Sans, Inter and
   Sometype Mono. The v3 pages use the specified faces; pages 01 and 02 use SF Pro.
   That difference is visible side by side and is not a mistake in the file.
4. **Two primary buttons, two shapes.** The card's Approve is a `Capsule`;
   `PrimaryButton` is still the 10pt rounded rect from the dark build.
5. **`GitHubPrimaryButton` is off-palette and off-shape** — connecting GitHub changes
   the card's primary action from a dark pill to a green rectangle.
6. **The card body has no fixed layout, by design.** `GeneratedBlocks` emits an amount,
   deadline, metric or side-by-side choice from the agent's own context string.
7. **The open-count badge renders on both segments** of `HomeSegmentedControl`.
8. **The product has two names** — Honmaru AI in the repo and the design system,
   TikTok for Work in the Xcode target, README and `tiktokforwork://` URL scheme.

## Keeping it in sync

The file is a snapshot, not a live mirror. When screens change materially in code,
regenerate the affected frames rather than hand-editing them.
