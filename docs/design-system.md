# Design System — "Hardworking dashboard on white marble"

Adopted from the ClickUp-style reference. Light theme, high-contrast
productivity dialect: white canvas, near-black filled CTAs, one relentless
9999px pill curve, color used surgically.

## Core rules

| Rule | Value |
|---|---|
| Canvas | `#ffffff` — 95% of every screen |
| Card surface | `#f8f9fa`, section band `#e9ebf0`, chip fill `#eeeeee` |
| Text | `#202020` primary · `#646464` secondary · `#838383` tertiary · `#090c1d` display headlines |
| Default border | `1px solid #e8e8e8` (hairline `#d4d4d4`) — elevation is borders, not shadows |
| Primary CTA | **Filled dark `#202020`, white text, 9999px pill** — never purple |
| Brand violet `#6647f0` | Badges, AI markers, brand moments only |
| Interactive blue `#0091ff` | Selected chips, links, outlined interactive borders |
| Status | Done `#6ee7b7` bg / dark text · In-progress `#0091ff` bg / white · Overdue-decline pink `#fa49a5` · Emerald outline `#00c07a` |
| Radii | buttons/badges/tags 9999px · cards 12px · large cards 20px · inputs 9px · images 16px |
| Spacing | 4px base unit, compact density; section gap 80px, element gap 12px |
| Display type | Plus Jakarta Sans (subst. Inter/system) 650–800, tracking −0.04em at 48px+ |
| Body type | Inter (subst. system-ui); never positive tracking |
| Meta labels | Sometype Mono (subst. ui-monospace) 10–12px uppercase, tracking +0.06–0.08em |
| Motion | 0.45s `cubic-bezier(0.33, 1, 0.68, 1)`; hovers 0.15s |
| Conic rainbow border | **At most one element per screen** — ours is the ＋ compose FAB |

## Component mapping (this product)

| App element | Treatment |
|---|---|
| Decision card | White, 1px `#e8e8e8`, radius 12–24px, subtle shadow only |
| Kind tag (Decision/Choice/Reply/FYI) | Mono uppercase; emerald / blue / violet / ash |
| Priority stripe | urgent `#fa49a5` · high `#0091ff` · medium `#d4d4d4` |
| Approve / primary buttons | Filled dark `#202020` pill |
| Secondary / ghost | White fill, `#e8e8e8` border, `#202020` text, pill |
| Selected chips (roles, options) | Blue `#0091ff` text + border, 8% blue tint fill |
| AI-recommended badge, routing reason bar, agent avatars | Brand violet `#6647f0` |
| ＋ FAB | White circle wrapped by the rotating 11-stop conic border (the page's one expressive moment) |
| Segmented (Cards/Classic) | `#eeeeee` track, white raised pill for selected |
| Billing segmented | Selected = filled dark pill |
| Settings | iOS inset-grouped: white cards, radius 16, `#e8e8e8` separators |
| Status pills | DONE mint bg/dark text · OPEN blue bg/white · DECLINED pink bg/white |
| Camera / viewfinder | Stays dark (`#111` fade) — the sanctioned dark panel |
| Undo toast, tab bar, sheets | White translucent material, `#e8e8e8` border, blur |

## Tokens (CSS)

```css
:root {
  --color-signal-white:#ffffff; --color-ink-black:#202020; --color-onyx:#090c1d;
  --color-carbon:#2a2a2a; --color-slate:#646464; --color-ash:#838383;
  --color-fog:#b3b3b3; --color-cloud:#d4d4d4; --color-bone:#e8e8e8;
  --color-mist:#f8f9fa; --color-plaster:#e9ebf0; --color-mercury:#eeeeee;
  --color-brand-violet:#6647f0; --color-signal-blue:#0091ff;
  --color-mint:#6ee7b7; --color-emerald:#00c07a; --color-teal-tag:#16c0a4;
  --gradient-rainbow-conic: conic-gradient(from 90deg,#7d5be7 19%,#bc3fda 28%,#fa24ce 37%,#fb49a5 45%,#fc6d7b 52%,#fd8461 55%,#fd9a46 58%,#f687c6 65%,#a3a0e0 80%,#4fb9fa 95%,#0091ff 100%);
  --gradient-primary: linear-gradient(83deg,#40ddff -5%,#7612fa 51%,#fa12e3 125%);
  --gradient-dark-fade: linear-gradient(#111111 24%, #000000);
  --font-display:'Plus Jakarta Sans',Inter,ui-sans-serif,system-ui,sans-serif;
  --font-body:'Inter',ui-sans-serif,system-ui,sans-serif;
  --font-mono:'Sometype Mono',ui-monospace,SFMono-Regular,Menlo,monospace;
  --radius-buttons:9999px; --radius-cards:12px; --radius-largecards:20px;
  --radius-inputs:9px; --radius-images:16px;
  --ease-settle:cubic-bezier(0.33,1,0.68,1);
  --shadow-subtle:rgba(0,0,0,.1) 0 1px 3px 0, rgba(0,0,0,.1) 0 1px 2px -1px;
}
```

## SwiftUI token mapping (`TikTokForWork/Design/Theme.swift`)

| Swift token | Value |
|---|---|
| `background` | `#FFFFFF` |
| `surface` | `#F8F9FA` |
| `surfaceRaised` | `#EEEEEE` |
| `textPrimary` | `#202020` |
| `textSecondary` | `#646464` |
| `textTertiary` | `#838383` |
| `accent` (brand) | `#6647F0` |
| `interactive` | `#0091FF` |
| `approve` | `#00C07A` |
| `reject` | `#FA49A5` |
| `issueGreen` | `#238636` (GitHub brand, unchanged) |
| Buttons | `Capsule()` fills; primary = `#202020` |

## Figma handoff

Live in [Honmaru-AI-Mobile-App-UI-UX-Design](https://www.figma.com/design/ii8w8x7gvN3wp70vlszBSa/Honmaru-AI-Mobile-App-UI-UX-Design)
on the `Refference` page (the team's Starter plan blocks extra pages), placed
in clear space right of the reference shots (x ≈ 18400):

- **Components row** — `Chrome/Status Bar`, `Chrome/Home Indicator`,
  `Button/Primary`, `Button/Ghost`, `Chrome/Tab Bar` (conic-ring ＋ FAB)
- **Section "Honmaru AI · Onboarding v3"** — 12 screens (390×844): Welcome,
  Create account, Bring your own AI, Call name, Role, Connect your tools,
  Scanning, Your projects, Who's who, House rules, Ready, Choose your plan
- **Section "Honmaru AI · Core App v3"** — 6 screens: Home Decision / Choice /
  Reply cards, Classic view, Capture, You (settings)

Fonts used in the file: Plus Jakarta Sans ExtraBold (display), Inter
(body/UI), Sometype Mono Medium (meta labels).

Known nit: on `A5 Capture`, wrapper rows still carry Figma's default white
fill and hide the dark viewfinder — select the rows under the screen frame
and set fill to none (hit the Starter-plan MCP call limit before the fix).

## Don'ts (enforced)

- No pure `#000` for text/background (camera viewfinder excepted)
- Violet never fills a primary CTA
- One conic-border element per screen, maximum
- No decorative gradients on cards or section backgrounds
- Don't mix radii within a component class — all buttons are pills
