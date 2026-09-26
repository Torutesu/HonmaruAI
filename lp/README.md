# Landing page

The public page for Honmaru AI. Static HTML, CSS and JS with no build step;
it makes no third-party requests: the three faces are self-hosted in `fonts/` (see its README).
Serve the folder with anything (`python3 -m http.server -d lp`) to work on
it; the language then comes from `?lang=` or the browser. To see the site as
it is published, build it and run it in the Pages runtime:

```bash
node lp/build.mjs dist            # a page per language, root worker, minified assets
npx wrangler@4 pages dev dist     # / redirects, /ja/ /en/ … are the pages
node --test lp/worker.test.mjs    # the root's redirect rules
```

| File | Holds |
|------|-------|
| `index.html` | Structure. Every visible string carries a `data-i18n*` key |
| `i18n.js` | Copy in the app's five languages: en, ja, es, fr, de |
| `styles.css` | Page tokens (light and dark), the phone, every section |
| `main.js` | The scroll engine, the ring canvas and the interactive parts |
| `build.mjs` | Builds the published site: `/<lang>/` pages with their words already in the HTML, the stylesheet inlined, the scripts minified |
| `worker.js` | The root `/`: sends Japan to `/ja/`, everyone else to `/en/`, unless the visitor chose a language on the page |

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

## Where people go

| Button | Destination |
|--------|-------------|
| iPhone | App Store: `apps.apple.com/jp/app/honmaruai/id6799302006` from the Japanese page, `apps.apple.com/app/id6799302006` from the others (Apple opens the visitor's own storefront) |
| Web | `honmaru-web.pages.dev/?lang=<page language>`; the web app reads `?lang=` until someone picks a language in the app |
| Mac, Windows, Android | Disabled buttons marked *Coming soon*, in the hero and in the last section |

The App Store and Google Play buttons are the stores' own badges, kept unaltered in `badges/`:
Apple's from developer.apple.com (Japanese on the Japanese page, English elsewhere) and Google's
from play.google.com, one per language, trimmed of their transparent margin. Google Play is shown
faded until the Android app is listed. The page picks the badge for its language through
`badge.appstore` / `badge.gplay` in `i18n.js`.

The links live in `i18n.js` as `href.web` and `href.ios`, per language.
iPhone Safari also offers the app through the Smart App Banner
(`apple-itunes-app`).

## Language by location

The published root `/` is answered by `worker.js`, which decides in this order:

1. an old `?lang=` link: a permanent redirect to that language;
2. the `hm_lang` cookie, set when someone picks a language in the menu;
3. the country Cloudflare sees: Japan gets `/ja/`, everyone else `/en/`.

The redirect is `private, no-store` and varies on the cookie, so no cache
passes one visitor's language to the next. Each language page names the
others with `hreflang`, and `x-default` points at the root.

## Behaviour

- On the published site the language is the path (`/ja/`). Picking another
  in the menu swaps the words in place, moves the URL to that language's
  path and sets the `hm_lang` cookie the root reads. Served from the source
  folder, it falls back to `?lang=`, then the last choice, then the browser.
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

1. creates the Pages project `honmaru-lp` if it doesn't exist yet;
2. attaches the site's domain — `honmaruai.com`, or the repository variable
   `LP_DOMAIN` — and its `www.` to the project, and adds their DNS records
   (`CNAME` to `honmaru-lp.pages.dev`, proxied) when the token may edit that
   zone. If it may not, the run's warnings name the two records to add by hand
   in Cloudflare DNS;
3. picks the addresses: links to the web app go to `app.honmaruai.com` (or
   the `APP_DOMAIN` variable) once it serves the app, else to
   `honmaru-web.pages.dev`; and the page itself is built for
   the domain once its root is answered by this page,
   otherwise `honmaru-lp.pages.dev`, so no link points at a domain that is
   not serving yet (`LP_SITE_URL` or the run's `site_url` input overrides it);
4. tests the worker (`worker.test.mjs`) and runs `build.mjs` for that address,
   which stops if any language lacks a string the page uses. It writes a page
   per language with absolute `og:url`, `canonical` and `hreflang` tags,
   inlines the stylesheet, minifies the scripts, and adds `_worker.js`,
   `_routes.json`, `robots.txt`, `sitemap.xml` and `_headers` (fonts are
   cached for a year). Built for the domain, the worker also sends
   `honmaru-lp.pages.dev` and `www.` there with a 301, path and all;
5. deploys, then checks on that address that every language page is the one
   just built, that `/` redirects (to `/en/` from the runner, to `/ja/` with
   a Japanese choice), and that pages.dev redirects to the domain.

It uses the same two secrets as Deploy Web. For the DNS records to be added
automatically, the API token also needs *Zone → DNS → Edit* on the domain's
zone; certificates for the domain are issued by Pages within minutes of the
records existing, and the next run (or a manual one) switches the page over.
