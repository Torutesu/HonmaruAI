# Design handoff — Figma

**File:** https://www.figma.com/design/6gMGzJwY1bHStnIKEhxu9h
Team: Select (pro) · Regenerated 2026-08-09

> **Mirrors `claude/testflight-light` @ `9dc4b82`, not `main`.**
> `main` has not moved since 30 July and nothing has been merged into it. This file
> tracks the newest branch — the only one carrying the white marble design system.

## Why this branch

Nine branches are open ahead of `main`, and three of them hold mutually incompatible
design directions:

| Direction | Where | Character |
|---|---|---|
| **B. Light "white marble"** | `claude/testflight-light` (8 Aug) | Written spec in `docs/design-system.md`. **This file.** |
| C. design v3 "calm" | `claude/current-features-gaps` (1 Aug) | Largest branch. Only light/dark system, iOS+Web shared tokens. |
| A. Dark placeholder | `main`, `cross-platform-strategy` | Never deliberately designed. |

Picking B is a working assumption. Choosing between B and C is still the first
real decision — see `docs/DESIGN_HANDOFF.ja.md` on
`claude/designer-project-handoff-docs` for the longer cross-branch map.

## Pages

| Page | Contents |
|------|----------|
| `00 · Read me` | Handoff brief: branch provenance, the two surfaces, real vs mocked, ranked open questions |
| `01 · Core app` | 5 screens — Home/Cards (two generated card shapes), Home/Classic, You, Capture |
| `02 · Onboarding` | 5 screens — welcome, routing explainer, swipe tutorial, GitHub sign-in (skippable), persona |
| `04 · Components` | 13 Figma components named after the SwiftUI structs |
| `05 · Tokens` | White marble palette, conic rainbow, type ramp, radius and spacing scales |

## Tokens

The `Tokens` collection (31 variables, single `Light` mode) mirrors
`TikTokForWork/Design/Theme.swift` plus the values `docs/design-system.md` defines but
Theme does not yet carry (`plaster`, `mint`, `onyx`).

Two things are deliberately *not* variable-bound:

- **Translucent tints** (kind tags at 10%, routing reason at 7%, block pills at 8%).
  Figma discards paint opacity when a colour variable is bound to a paint, so these
  are raw paints.
- **The conic rainbow.** Figma cannot bind a gradient to a variable.

## Open questions raised in the file

Full list on `00 · Read me`. The ones that need a decision rather than polish:

1. Pick one of the three design directions.
2. **The design system's typefaces do not ship.** `docs/design-system.md` specifies
   Plus Jakarta Sans, Inter and Sometype Mono. There are no font files in the project
   and no `Font.custom` anywhere — every screen renders SF Pro.
3. **Two primary buttons, two shapes.** The card's Approve is a `Capsule`;
   `PrimaryButton` — used by all five onboarding screens — is still the 10pt rounded
   rect from the dark build.
4. **`GitHubPrimaryButton` is off-palette and off-shape.** Connecting GitHub silently
   changes the card's primary action from a dark pill to a green rectangle.
5. **The card body has no fixed layout, by design.** `GeneratedBlocks` emits an amount,
   deadline, metric or side-by-side choice from the agent's own context string. This
   needs designing as a system of blocks, not as one card.
6. **The open-count badge renders on both segments** of `HomeSegmentedControl`.
7. **The product has two names** — Honmaru AI in the repo and the design system,
   TikTok for Work in the Xcode target, README and `tiktokforwork://` URL scheme.

## Related Figma work

`docs/design-system.md` on the same branch points at
[Honmaru-AI-Mobile-App-UI-UX-Design](https://www.figma.com/design/ii8w8x7gvN3wp70vlszBSa),
which holds the Onboarding v3 (12 screens) and Core App v3 (6 screens) sections on its
`Refference` page.

That file is on a **Starter** team, so the Figma MCP server refuses tool calls against
it — the same blocker recorded at the top of `docs/figma/classic-slack-rebuild.js`.
Moving it to a Professional team would unblock both that staged script and any attempt
to consolidate the two files.

## Keeping it in sync

The Figma file is a snapshot, not a live mirror. When screens change materially in
code, regenerate the affected frames rather than hand-editing them.
