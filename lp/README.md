# Landing page

The public page for Honmaru AI. Static HTML, CSS and JS with no build step;
the only outside request is the Inter webfont (Apple devices use SF Pro).
Serve the folder with anything (`python3 -m http.server -d lp`) or upload it
to Cloudflare Pages as is.

| File | Holds |
|------|-------|
| `index.html` | Structure. Every visible string carries a `data-i18n*` key |
| `i18n.js` | Copy in the app's five languages: en, ja, es, fr, de |
| `styles.css` | Page tokens (light and dark), the phone, every section |
| `main.js` | The scroll engine and the interactive parts |

## The page, top to bottom

1. **Stage.** The headline, then an iPhone that rises into place and stays
   pinned while the story plays against your scroll. First the AI glow while it
   triages. Then the card swipes to approve, a GitHub banner drops in, and the
   next card comes forward. The phone is the app's own UI (DecisionCardView,
   AppTabBar) rebuilt in HTML, so it follows the page into dark mode the way the
   app does.
2. **Statement.** Words light up as they are read.
3. **How it works.** Type or pick an instruction. It travels You → Your AI →
   their AI → them and lands as a card with its GitHub Issue. This is the
   keyword fallback, not the model router, and the footer says so.
4. **Highlights.** A snapping gallery with autoplay, a progress dot and a
   pause button.
5. **Numbers, Privacy, CTA, footer.**

## Behaviour

- Language comes from `?lang=`, then the last choice, then the browser.
  Switching rewrites `?lang=` so a shared link keeps it.
- Appearance follows the system until the toggle is used, then remembers.
  Both are applied before first paint.
- Every scroll-linked effect runs off one `requestAnimationFrame` loop and
  only writes `transform` and `opacity`.
- `prefers-reduced-motion` stops the loops and the autoplay.
