# Landing page

The public page for Honmaru AI. Static HTML, CSS and JS with no build step;
it makes no third-party requests: the three faces are self-hosted in `fonts/` (see its README).
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
- Every scroll-linked effect runs off one `requestAnimationFrame` loop that
  reads every rect first and then writes, so layout runs once per frame.
- The ring canvas stamps its walls from a cached layer and redraws them only
  when the phone moves or the theme flips. Touch and small screens draw at
  30 fps, and the loop stops when the stage is off screen. The conic ring
  turns only while it is visible.
- `prefers-reduced-motion` stops the loops and the autoplay.

## Deploying

**Deploy Landing Page** (`.github/workflows/deploy-lp.yml`) runs on every push
to `main` that touches `lp/`, and can also be run by hand from Actions. It:

1. checks that every string the page uses exists in all five languages;
2. minifies the scripts and inlines the stylesheet, so the first paint waits on the HTML alone;
3. rewrites `og:image` and `og:url` to absolute addresses and adds `robots.txt`, `sitemap.xml` and cache headers (`_headers`: fonts cached for a year);
4. creates the Pages project `honmaru-lp` if it doesn't exist yet;
5. deploys, and checks that the live site serves this commit.

It uses the same two secrets as Deploy Web.

Once the site is up, add the custom domain once in the Cloudflare dashboard:
Pages → `honmaru-lp` → Custom domains. After that, set the repository
variable `LP_SITE_URL` (for example `https://honmaruai.com`) so link previews
point at that domain.
