// The root of the landing page. The pages themselves are static files; this
// answers "/" (it runs for pages, not for scripts, fonts and images — see
// _routes.json in build.mjs), and sends each visitor to the page in their
// language:
//
//   1. an old ?lang= link keeps working (a permanent redirect);
//   2. a language chosen on the page — the hm_lang cookie — wins;
//   3. otherwise Japan gets /ja/ and everyone else /en/, by the country
//      Cloudflare sees the request come from.
//
// The redirect is private and varies on the cookie, so no cache hands one
// visitor's language to the next.
//
// Once the page has its own domain, the other addresses it answers on — the
// pages.dev one and www. — send people there, path and all, so the domain is
// the only address anyone shares. Preview deployments (<hash>.<project>.pages.dev)
// are left alone. build.mjs writes the domain into CANONICAL.

const LANGS = ['en', 'ja', 'es', 'fr', 'de'];
const CANONICAL = '';

function pickLanguage(request) {
  const url = new URL(request.url);
  const asked = url.searchParams.get('lang');
  if (LANGS.includes(asked)) return { lang: asked, permanent: true };
  const chosen = /(?:^|;\s*)hm_lang=([a-z]{2})(?:;|$)/.exec(request.headers.get('Cookie') || '');
  if (chosen && LANGS.includes(chosen[1])) return { lang: chosen[1], permanent: false };
  const country = request.cf && request.cf.country;
  return { lang: country === 'JP' ? 'ja' : 'en', permanent: false };
}

function isAlias(host, canonical) {
  return host === 'www.' + canonical || /^[^.]+\.pages\.dev$/.test(host);
}

export function makeWorker(canonical) {
  return {
    async fetch(request, env) {
      const url = new URL(request.url);
      if (canonical && isAlias(url.hostname, canonical)) {
        return Response.redirect('https://' + canonical + url.pathname + url.search, 301);
      }
      if (url.pathname !== '/') return env.ASSETS.fetch(request);
      const { lang, permanent } = pickLanguage(request);
      url.searchParams.delete('lang');
      return new Response(null, {
        status: permanent ? 301 : 302,
        headers: {
          Location: '/' + lang + '/' + url.search,
          'Cache-Control': 'private, no-store',
          Vary: 'Cookie',
        },
      });
    },
  };
}

export default makeWorker(CANONICAL);
