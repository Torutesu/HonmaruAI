// Builds the published landing page from lp/ into one folder for Cloudflare Pages.
//
//   node lp/build.mjs [out=dist] [site=https://honmaru-lp.pages.dev]
//
//   /<lang>/index.html  a page per language (en ja es fr de) with its words
//                       already in the HTML, so a Japanese reader never sees
//                       English first and each language has its own URL
//   /index.html         a plain fallback that points at the languages; on
//                       Pages the root is answered by _worker.js instead
//   _worker.js          sends "/" to /ja/ from Japan and /en/ from elsewhere,
//   _routes.json        unless the visitor chose a language on the page;
//                       the worker runs for "/" only, the rest is static
//   main.js, i18n.js    minified; the stylesheet is inlined into every page
//   fonts/, icon.svg, og.png, robots.txt, sitemap.xml, _headers
//
// It fails, naming the key, if any language lacks a string the page uses.

import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const out = path.resolve(process.argv[2] || 'dist')
const site = (process.argv[3] || 'https://honmaru-lp.pages.dev').replace(/\/+$/, '')
const LANGS = ['en', 'ja', 'es', 'fr', 'de']
const OG_LOCALE = { en: 'en_US', ja: 'ja_JP', es: 'es_ES', fr: 'fr_FR', de: 'de_DE' }
const ESBUILD = ['-y', 'esbuild@0.24.2']

const read = (f) => fs.readFileSync(path.join(here, f), 'utf8')
function fail(message) {
  console.error('::error::' + message)
  process.exit(1)
}

// --- strings -----------------------------------------------------------------

const sandbox = { window: {} }
vm.runInNewContext(read('i18n.js'), sandbox)
const I18N = sandbox.window.I18N
const source = read('index.html')

const used = [...new Set([...source.matchAll(/data-i18n(?:-html|-placeholder|-aria|-href)?="([^"]+)"/g)].map((m) => m[1]))]
for (const lang of LANGS) {
  if (!I18N[lang]) fail(`i18n.js has no ${lang}`)
  const missing = used.filter((key) => !(key in I18N[lang]))
  if (missing.length) fail(`${lang} is missing ${missing.join(', ')}`)
}

function translator(lang) {
  return (key, vars) => {
    let value = key in I18N[lang] ? I18N[lang][key] : I18N.en[key]
    if (vars) value = value.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? '')
    return value
  }
}

const escText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const escAttr = (s) => escText(s).replace(/"/g, '&quot;')

function setAttr(attrs, name, value) {
  const re = new RegExp(`(\\s${name}=")[^"]*(")`)
  const v = escAttr(value)
  return re.test(attrs) ? attrs.replace(re, (_, a, b) => a + v + b) : `${attrs} ${name}="${v}"`
}

// Replace a string that must be there exactly once; a template that drifted
// from the build should stop the deploy, not ship half-translated.
function swap(html, find, replacement, what) {
  const hits = typeof find === 'string' ? html.split(find).length - 1 : (html.match(new RegExp(find.source, 'g')) || []).length
  if (hits !== 1) fail(`expected one ${what}, found ${hits}`)
  return html.replace(find, typeof replacement === 'function' ? replacement : () => replacement)
}

// The index of the tag that closes the element opened just before `from`,
// counting nested elements of the same name.
function closingTag(html, tag, from) {
  const re = new RegExp(`<(/?)${tag}(?=[\\s>/])[^>]*>`, 'g')
  re.lastIndex = from
  let depth = 1
  let m
  while ((m = re.exec(html))) {
    if (m[1]) {
      if (--depth === 0) return m.index
    } else if (!m[0].endsWith('/>')) depth++
  }
  fail(`no closing </${tag}>`)
}

// Fill every data-i18n* hook the way main.js's applyLang does in the browser.
function localizeHooks(html, t) {
  const TARGET = { 'data-i18n-placeholder': 'placeholder', 'data-i18n-aria': 'aria-label', 'data-i18n-href': 'href' }
  const open = /<([a-zA-Z][\w-]*)(\s[^<>]*?)?(\/?)>/g
  let result = ''
  let pos = 0
  let m
  while ((m = open.exec(html))) {
    const [whole, tag, original = '', selfClose] = m
    if (!original.includes('data-i18n')) continue
    let attrs = original
    for (const [hook, target] of Object.entries(TARGET)) {
      const key = new RegExp(`\\s${hook}="([^"]+)"`).exec(original)
      if (key) attrs = setAttr(attrs, target, t(key[1]))
    }
    const text = /\sdata-i18n="([^"]+)"/.exec(original)
    const rich = /\sdata-i18n-html="([^"]+)"/.exec(original)
    result += html.slice(pos, m.index) + `<${tag}${attrs}${selfClose}>`
    pos = m.index + whole.length
    if (text || rich) {
      const end = closingTag(html, tag, pos)
      result += text ? escText(t(text[1])) : t(rich[1])
      pos = end
      open.lastIndex = end
    }
  }
  return result + html.slice(pos)
}

// --- build -------------------------------------------------------------------

fs.rmSync(out, { recursive: true, force: true })
fs.mkdirSync(path.join(out, 'fonts'), { recursive: true })

const tmp = fs.mkdtempSync(path.join(out, '.css-'))
const esbuild = (...args) => execFileSync('npx', [...ESBUILD, ...args, '--log-level=warning'], { stdio: 'inherit' })
esbuild(path.join(here, 'main.js'), '--minify', '--target=es2019', `--outfile=${path.join(out, 'main.js')}`)
esbuild(path.join(here, 'i18n.js'), '--minify', '--target=es2019', `--outfile=${path.join(out, 'i18n.js')}`)
esbuild(path.join(here, 'styles.css'), '--minify', '--loader:.css=css', `--outfile=${path.join(tmp, 'styles.css')}`)
// Pages live one folder down (/ja/), so every local url() becomes absolute.
const css = fs.readFileSync(path.join(tmp, 'styles.css'), 'utf8').replace(/url\((["']?)(?!data:|https?:|\/)/g, 'url($1/')
fs.rmSync(tmp, { recursive: true, force: true })

const alternates = LANGS.map((l) => `<link rel="alternate" hreflang="${l}" href="${site}/${l}/">`).join('\n') +
  `\n<link rel="alternate" hreflang="x-default" href="${site}/">`

for (const lang of LANGS) {
  const t = translator(lang)
  let html = source
  html = swap(html, '<link rel="stylesheet" href="styles.css">', `<style>${css}</style>`, 'stylesheet link')
  html = swap(html, '<html lang="en">', `<html lang="${lang}" data-prerendered="${lang}">`, '<html>')
  html = swap(html, /<title>[^<]*<\/title>/, `<title>${escText(t('meta.title'))}</title>`, '<title>')
  html = swap(html, /<meta name="description" content="[^"]*">/, `<meta name="description" content="${escAttr(t('meta.desc'))}">`, 'description')
  html = swap(html, /<meta property="og:title" content="[^"]*">/, `<meta property="og:title" content="${escAttr(t('meta.title'))}">`, 'og:title')
  html = swap(html, /<meta property="og:description" content="[^"]*">/, `<meta property="og:description" content="${escAttr(t('meta.desc'))}">`, 'og:description')
  html = swap(html, '<meta property="og:image" content="og.png">',
    `<meta property="og:image" content="${site}/og.png">\n<meta property="og:url" content="${site}/${lang}/">\n` +
    `<meta property="og:locale" content="${OG_LOCALE[lang]}">\n<link rel="canonical" href="${site}/${lang}/">\n${alternates}`, 'og:image')
  html = localizeHooks(html, t)
  // what applyLang sets outside the hooks
  html = swap(html, '<span class="lang-code" id="lang-code">EN</span>', `<span class="lang-code" id="lang-code">${lang.toUpperCase()}</span>`, 'language code')
  html = swap(html, /(<button class="nav-icon" id="lang-btn"[^>]*?)>/, (_, tag) => `${tag} aria-label="${escAttr(lang.toUpperCase() + ' · ' + t('a11y.language'))}">`, 'language button')
  html = swap(html, `<li role="option" data-lang="${lang}">`, `<li role="option" data-lang="${lang}" aria-selected="true">`, 'language option')
  html = swap(html, /(id="fregion">)[^<]*</, (_, a) => `${a}${escText(t('region'))}<`, 'region')
  html = swap(html, /(id="fl-their-ai">)[^<]*</, (_, a) => `${a}${escText(t('how.theirAi', { name: 'Dana' }))}<`, 'their-AI label')
  // one folder down, so local files are addressed from the root
  html = html.replace(/(\s(?:src|href)=")(?![a-z][a-z0-9+.-]*:|#|\/|\?)/g, '$1/')
  fs.mkdirSync(path.join(out, lang), { recursive: true })
  fs.writeFileSync(path.join(out, lang, 'index.html'), html)
}

// Reached only without the worker (a local preview of this folder).
fs.writeFileSync(path.join(out, 'index.html'), `<!doctype html>
<html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Honmaru AI</title><meta name="robots" content="noindex"><meta http-equiv="refresh" content="0; url=/en/">
<p>${LANGS.map((l) => `<a href="/${l}/">${l.toUpperCase()}</a>`).join(' · ')}</p>
`)

fs.copyFileSync(path.join(here, 'worker.js'), path.join(out, '_worker.js'))
fs.writeFileSync(path.join(out, '_routes.json'), JSON.stringify({ version: 1, include: ['/'], exclude: [] }) + '\n')
for (const f of ['icon.svg', 'og.png']) fs.copyFileSync(path.join(here, f), path.join(out, f))
for (const f of fs.readdirSync(path.join(here, 'fonts')).filter((f) => f.endsWith('.woff2'))) {
  fs.copyFileSync(path.join(here, 'fonts', f), path.join(out, 'fonts', f))
}

fs.writeFileSync(path.join(out, 'robots.txt'), `User-agent: *\nAllow: /\nSitemap: ${site}/sitemap.xml\n`)
const links = LANGS.map((l) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${site}/${l}/"/>`).join('\n')
fs.writeFileSync(path.join(out, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">
${LANGS.map((l) => `  <url>\n    <loc>${site}/${l}/</loc>\n${links}\n    <xhtml:link rel="alternate" hreflang="x-default" href="${site}/"/>\n  </url>`).join('\n')}
</urlset>
`)
fs.writeFileSync(path.join(out, '_headers'), `/*
  X-Content-Type-Options: nosniff
  Referrer-Policy: strict-origin-when-cross-origin
/fonts/*
  Cache-Control: public, max-age=31536000, immutable
/*.js
  Cache-Control: public, max-age=3600, must-revalidate
/og.png
  Cache-Control: public, max-age=86400
/icon.svg
  Cache-Control: public, max-age=86400
`)

console.log(`built ${LANGS.map((l) => '/' + l + '/').join(' ')} for ${site} into ${path.relative(process.cwd(), out) || '.'}`)
