# TikTok for Work — Design

> **Note:** These are early design notes, not a settled system — and several values here
> (colors, type sizes, radii) no longer match the code. The UI is still at mockup stage;
> the real design system has yet to be defined. For what the code actually does today and
> what remains open, see [docs/DESIGN_HANDOFF.en.md](docs/DESIGN_HANDOFF.en.md) /
> [docs/DESIGN_HANDOFF.ja.md](docs/DESIGN_HANDOFF.ja.md).

## Direction

Clean, flat, restrained. Linear clarity in a vertical feed shell. No gradients, no decorative borders, no heavy bold type.

## Principles

1. One card, one decision — full screen, no clutter
2. Hierarchy through size and color, not weight
3. Surfaces over lines — separate regions with background steps, not borders
4. Accent used once per screen max
5. Motion is quick and functional (120–200ms)

## Color

| Token | Hex | Use |
|-------|-----|-----|
| background | `#09090B` | App canvas |
| surface | `#111113` | Cards, sheets |
| surfaceRaised | `#18181B` | Inputs, elevated bars |
| textPrimary | `#EDEDEF` | Titles, body |
| textSecondary | `#8B8B93` | Summaries, labels |
| textTertiary | `#5C5C63` | Metadata, chips |
| accent | `#5E6AD2` | Primary action only |
| approve | `#4ADE80` | Approve label |
| reject | `#F87171` | Reject label |

## Typography

SF Pro.system. Prefer `.regular` and `.medium`. Avoid `.bold`.

| Role | Size | Weight |
|------|------|--------|
| cardTitle | 22 | medium |
| cardBody | 15 | regular |
| label | 13 | regular |
| caption | 12 | regular |
| metadata | 11 | regular |

## Spacing

4pt grid. Card padding: 24. Section gaps: 16. Screen horizontal: 20.

## Radius

- Cards: 0 (full bleed in feed)
- Buttons: 4
- Inputs: 4
- Sheets: 12 (system default)

## Components

### Decision Card
- Flat `surface` fill, no border, no gradient
- Top: type + priority as plain text (tertiary / secondary)
- Middle: title (medium 22), summary (regular 15), context (secondary 13)
- Bottom: action row — primary filled accent button, secondary text-only buttons

### Feed chrome
- Top: user name + pending count, no background bar
- Bottom: single AI input trigger on `surfaceRaised`, 4px radius

### Auth
- Solid background, centered stack
- User picker as segmented control
- PAT field: flat `surfaceRaised`, no border

## Copy voice

- "Tell your AI" not "Send message"
- "Decision recorded" not "Message sent"
- Sentence case, short, no filler

## v1 scope

| Real | Mocked |
|------|--------|
| Feed, cards, actions | AI routing (keyword router) |
| Local multi-user switch | WebSocket (Phase 5) |
| GitHub Issues via PAT | Org graph UI |
| In-memory card store | OAuth |
