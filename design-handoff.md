# Design handoff — Figma

**File:** [TikTok for Work — Current State (2026-08)](https://www.figma.com/design/6gMGzJwY1bHStnIKEhxu9h)
Team: Select (pro) · Last generated: 2026-08-09

Everything in that file was generated from the SwiftUI source via the Figma MCP server, not from a
previous design file. Where `design.md` and the code disagreed, the code won.

## Pages

| Page | Contents |
|------|----------|
| `00 · Read me` | Handoff brief: what the product is, the one flow that matters, real vs mocked, and the ranked open design questions |
| `01 · Screens` | 8 iPhone frames (393×852) — Auth signed out / repo selected, Feed empty, Decision Card pending, mid-swipe, issue created, drafting banner, processing overlay |
| `02 · Sheets` | 7 sheets — Your AI, Review card, Card detail, Revise, Delegate, Switch user, Organization. Detents are in the frame names |
| `03 · Components` | 11 Figma components named after the structs in `Design/Components.swift` |
| `04 · Tokens` | Colour, type, spacing and radius, each bound to a variable in the `Tokens` collection |

## Tokens

The `Tokens` variable collection (21 variables, single `Dark` mode) mirrors
`TikTokForWork/Design/Theme.swift`. Every fill and corner radius in the file is bound to it, so
recolouring a variable updates every screen.

One addition: `color/warning` (`#FBBF24`). It is used in code for high priority and deadline
insights but is not declared in `Theme.swift`.

## Open questions raised in the file

Listed in full on `00 · Read me`. The ones that need a product decision rather than polish:

1. `design.md` no longer matches `Theme.swift` — background, surface, card title size and button
   radius all differ. One of the two needs to be retired.
2. A single Decision Card offers five ways to act (Create issue, Decline, Revise, Delegate, plus
   two swipe directions) on a surface whose stated principle is "one card, one decision".
3. `issueGreen` `#238636` is GitHub's brand green and the only saturated fill in the app.
4. Resolved cards have ~200pt of empty space below the fold once the action block is gone.
5. The org graph renders as flat rows plus monospaced relationship strings, but routing decisions
   are justified from it.

## Keeping it in sync

Re-running the generation overwrites nothing automatically — the Figma file is a snapshot. When
screens change materially in code, regenerate the affected frames rather than hand-editing them,
so the file keeps its single source of truth.

## Not represented

Motion (120–200ms per `design.md`), haptics, and native iOS controls (repository picker menu,
confirmation dialog, error alerts) are approximated or absent.
