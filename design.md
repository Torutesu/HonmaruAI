# TikTok for Work — Design v2

## Direction

Playful-premium dark, alive with light. Deep indigo-biased near-black canvas with an ambient accent glow; elevated rounded cards floating over it; gradient accents that feel electric, never corporate. A full light theme with the same soul. (v1 was flat/Linear-quiet; v2 moves to the glow-and-depth language of best-in-class consumer apps while keeping the one-card-one-decision discipline.)

## Principles

1. One card, one decision — full screen focus, now on an elevated surface
2. Depth through glow and elevation, not borders
3. The accent is light, not paint: gradients and glows on the actions that matter
4. Both themes are first-class — tokens adapt, views never branch on scheme
5. Motion stays quick and functional (150–250ms); glow is ambient, not animated

## Color tokens (adaptive)

| Token | Dark | Light | Use |
|-------|------|-------|-----|
| background | `#0A0B12` | `#F3F4F9` | Canvas (with radial accent glow at top) |
| surface | `#12141D` | `#FFFFFF` | Cards, sheets |
| surfaceRaised | `#1B1E2A` | `#EAECF4` | Inputs, chips, secondary fills |
| textPrimary | `#F2F3F8` | `#171923` | Titles, body |
| textSecondary | `#9AA0B4` | `#555B70` | Summaries, labels |
| textTertiary | `#646B80` | `#8A90A5` | Metadata |
| accent | `#6E7BF2` | `#5561D6` | Brand indigo (brighter in dark for glow) |
| accentAlt | `#9C6BFF` | `#7B5BD6` | Gradient end |
| approve | `#4ADE80` | `#1FA45C` | Positive |
| issueGreen | `#2EA043` | `#1F883D` | GitHub action |
| reject | `#FF7B87` | `#E5484D` | Negative |
| warn | `#FFC24B` | `#B47D0E` | High priority |

`accentGradient` = accent → accentAlt (topLeading → bottomTrailing).

All tokens are dynamic colors (UIKit trait provider). Appearance setting: System / Dark / Light, persisted in `@AppStorage("appearanceMode")`, applied via `preferredColorScheme` at the root.

## Typography

SF Pro; display roles use **SF Rounded** for the playful-premium voice.

| Role | Size | Weight | Design |
|------|------|--------|--------|
| title | 24 | semibold | rounded |
| body | 16 | regular | default |
| caption | 13 | regular | default |
| label | 12 | medium | default |
| micro | 11 | regular | default |

Buttons: 16 semibold rounded.

## Shape & depth

- Cards: radius 22 (continuous), hairline accent stroke (10%), soft black shadow (22/10)
- Buttons/inputs: radius 14; chips: radius 10 or capsule
- Sheets: radius 24
- `accentGlow()`: accent-colored shadow under primary actions and the compose bar
- `AppBackdrop`: canvas + radial accent glow bleeding from the top of every screen

## Components

- **Decision Card**: elevated `surface` container with margin, floating over the glowing backdrop. Content hierarchy unchanged (type/priority · why-you rail · title · summary · context chips · sources · actions)
- **PrimaryButton**: accentGradient fill, white text, glow. GitHub button: issueGreen with green glow
- **ComposeBar**: capsule, surface fill, accent stroke + subtle glow, gradient sparkle, trailing mic
- **Recommendation row / source chips**: accent-tinted 10% fills — light, tappable, never shouting
- **Settings**: card-surface sections; appearance picker as three glowing tiles

## Copy voice

Unchanged: "Tell your AI", "Decision recorded", sentence case, short, no filler.
