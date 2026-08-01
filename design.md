# TikTok for Work — Design v3

## Direction

**Calm.** A near-neutral dark canvas with a faint cool cast; hierarchy from spacing, weight and one accent used sparingly. Colour carries meaning and never decoration. A tool you look at for eight hours should recede — the decision on the card is the only thing asking for attention.

v2 was the opposite bet: an ambient purple glow behind every screen, gradient pills, a saturated green primary next to a violet accent, 22px radii and a rounded display face. It read as a toy, and the chrome competed with the content it was supposed to hold.

## Principles

1. One card, one decision — full-screen focus, but the card is only as tall as its content
2. **One accent.** If two things are both coloured, neither is emphasis
3. Depth from a hairline and a 1px shadow, not from glow — elevation is a fact, not an effect
4. State is the only other colour: approve / decline / warn / urgent, nothing else
5. Both themes are first-class — tokens adapt, views never branch on scheme
6. Motion stays quick and functional (120–200ms); nothing ambient, nothing animated for its own sake

## Color tokens (adaptive)

| Token | Dark | Light | Use |
|-------|------|-------|-----|
| background | `#0B0C0E` | `#FBFBFC` | Canvas — flat, no gradient |
| surface | `#141518` | `#FFFFFF` | Cards, sheets |
| surfaceRaised | `#1C1E22` | `#F2F3F5` | Inputs, chips, secondary fills |
| overlay | `#212429` | `#FFFFFF` | Palette, modals |
| textPrimary | `#ECEDEF` | `#16181C` | Titles, body |
| textSecondary | `#9EA3AB` | `#5C626C` | Summaries, labels |
| textTertiary | `#6B7078` | `#8B919B` | Metadata |
| accent | `#7C8CF8` | `#4F5BD5` | The one accent — links, selection, marks |
| accentStrong | `#6474F0` | `#4049C4` | The single primary action per screen |
| approve | `#3FB96B` | `#1A8245` | Positive state (not the primary button) |
| reject | `#E5646E` | `#C9333C` | Negative state, urgent priority |
| warn | `#D9A441` | `#9A6B0C` | High priority |
| hairline | `rgba(255,255,255,.08)` | `rgba(16,18,22,.10)` | Card and column edges |

`issueGreen` now aliases `accentStrong`, and `accentAlt` aliases `accent`: the gradient pair is gone, but both names survive so call sites did not all have to change at once.

## Scale

| | Value | Note |
|---|---|---|
| Radius | 6 / 8 / 12 | 22 read as a toy; 8–12 reads as a tool |
| Type | 11 / 12.5 / 14 / 16 / 20 / 25 | One family — the rounded display face is gone |
| Tracking | −0.02em on display, +0.06em on uppercase labels | |
| Shadow | `0 1px 2px` resting, `0 8px 24px` lifted | Overlays lift; cards do not |


All tokens are dynamic colors (UIKit trait provider on iOS, `[data-theme]` on the web). Appearance setting: System / Dark / Light, persisted in `@AppStorage("appearanceMode")` / `localStorage`, applied via `preferredColorScheme` at the root and a `data-theme` attribute in the browser.

## Typography

One family throughout — the system sans. v2 used SF Rounded for display roles; it was the loudest decision in the whole system and it made a decision tool read as a game.

| Role | Size | Weight |
|------|------|--------|
| title | 21 (iOS) / 20 (web) | semibold |
| body | 15 / 14 | regular |
| caption | 13 / 12.5 | regular |
| label | 12 / 12.5 | medium |
| micro | 11 | regular |

Numbers that sit in columns (lead times, counts, timestamps) use tabular figures so they stop dancing.

## Shape & depth

- Cards: radius 12 (continuous), neutral hairline (8%), `0 1px 2px` shadow — present, not floating
- Buttons/inputs: radius 8; chips: radius 6
- Sheets and the command palette: radius 12–16, `0 8px 24px` — only things that genuinely sit *above* the page get a lift
- Priority is a dot, not a coloured word: you register it without reading it

## Components

- **Decision Card**: a `surface` container centred in the viewport, sized to its content. Header is one line (priority dot · sender · type · time); route and routing reason are one subordinate line under the summary, not two stacked blocks. Context chips drop anything the header already said
- **PrimaryButton**: `accentStrong` fill, white text, no glow — one per screen. The GitHub action uses the same fill; a saturated green beside a violet accent was two hues competing for the same job
- **Secondary actions**: outlined ghosts. Decline turns red on hover only — a destructive option should not look destructive until you reach for it
- **ComposeBar**: a bordered field, not a glowing capsule
- **Recommendation / source chips**: outlined, neutral; the recommendation carries a 2px accent edge and nothing else
- **Settings and filters**: segmented controls on `raised`, active segment lifted to `surface` — no filled accent tiles

## Copy voice

Unchanged: "Tell your AI", "Decision recorded", sentence case, short, no filler.
