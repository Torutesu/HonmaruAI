# Landing page

The public page for Honmaru AI. Static HTML, CSS and JS with no build step;
the only outside request is Google Fonts (Plus Jakarta Sans, Inter, Sometype Mono).
Serve the folder with anything (`python3 -m http.server -d lp`) or upload it
to Cloudflare Pages as is.

| File | Holds |
|------|-------|
| `index.html` | Structure. Every visible string carries a `data-i18n*` key |
| `i18n.js` | Copy in the app's five languages: en, ja, es, fr, de |
| `styles.css` | Page tokens (light and dark), the phone, every section |
| `main.js` | The scroll engine, the ring canvas and the interactive parts |

## The page, top to bottom

The idea comes from the name. A castle's 本丸 (honmaru) is its innermost
keep, where decisions are made; everything around it is wall.

1. **Stage.** The headline, with "messages" struck out, next to an iPhone
   inside three rings: 三の丸, 二の丸, 本丸. Messages drift along the outer
   walls, and now and then the AI lets one fall inward to the phone. As you
   scroll, the phone stays pinned and a numbered rail (Triage, Decide,
   Record, Next) runs the story: the card swipes to approve, the GitHub
   banner drops in, and the next card comes forward. The phone is the app's
   own UI (DecisionCardView, AppTabBar) rebuilt in HTML, and it follows the
   page into dark mode.
2. **The keep.** Why "Honmaru". The text lights up as it is read, and the
   castle plan draws itself wall by wall.
3. **How it works.** Type or pick an instruction. It travels You → Your AI →
   their AI → them and lands as a card with its GitHub Issue. This demo runs
   the keyword fallback, not the model router, and the footer says so.
4. **Inside the walls.** Five numbered feature rows, each with a small
   animated visual.
5. **One gate into the keep.** The relay's access rules.
6. **Step inside.** The page's single conic-ring button, which is the rule
   in docs/design-system.md, then the footer.

Type and colour come from docs/design-system.md: Plus Jakarta Sans, Inter
and Sometype Mono; #202020 pill buttons; brand violet for AI moments only.

## Behaviour

- Language comes from `?lang=`, then the last choice, then the browser.
  Switching rewrites `?lang=` so a shared link keeps it.
- Appearance follows the system until the toggle is used, then remembers.
  Both are applied before first paint.
- Every scroll-linked effect runs off one `requestAnimationFrame` loop and
  only writes `transform` and `opacity`.
- `prefers-reduced-motion` stops the loops and the autoplay.
