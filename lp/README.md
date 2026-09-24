# Landing page

The public page for Honmaru AI. Static HTML/CSS/JS, no build step, no
dependencies beyond Google Fonts — open `index.html` through any static
server (`python3 -m http.server -d lp`) or upload the folder to Cloudflare
Pages as it is.

| File | What it holds |
|------|---------------|
| `index.html` | Structure. Every visible string carries a `data-i18n*` key |
| `i18n.js` | Copy in the app's five languages (en, ja, es, fr, de) |
| `styles.css` | Tokens from `docs/design-system.md`, with a dark set |
| `main.js` | The interactive parts, below |

## What moves

- **Hero** — a living org graph on canvas: messages hop AI → AI and the
  receiving node lights up. The cursor bends it; a click fires a message.
  Beside it, a phone with three real-looking Decision Cards you can swipe
  (or press ← / → / the buttons).
- **The old way** — a scroll-pinned scene: channel pings pile up, blur, then
  collapse into the one card that needed you.
- **How it works** — type an instruction (or pick one) and watch it route
  You → Your AI → their AI → them, land as a card, and get its GitHub Issue.
  It is the keyword fallback, not the model router — enough to show the idea.
- **Features** — bento tiles with a cursor spotlight; the language tile shows
  one card as each reader would get it.

## Language and theme

Language is picked from `?lang=`, then the last choice, then the browser;
switching rewrites `?lang=` so a link keeps it. Theme follows the system
until the toggle is used, then remembers. Both are set before first paint.
`prefers-reduced-motion` stops the canvas, the pinned scene and the loops.
