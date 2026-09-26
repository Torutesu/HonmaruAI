// node --test lp/worker.test.mjs
import { test } from 'node:test'
import assert from 'node:assert/strict'
import worker, { makeWorker } from './worker.js'

const env = { ASSETS: { fetch: (req) => new Response('asset ' + new URL(req.url).pathname) } }
function visit(path, { country, cookie } = {}) {
  const headers = new Headers(cookie ? { Cookie: cookie } : {})
  return worker.fetch({ url: 'https://honmaru-lp.pages.dev' + path, headers, cf: country ? { country } : undefined }, env)
}

test('a visitor from Japan lands on the Japanese page', async () => {
  const res = await visit('/', { country: 'JP' })
  assert.equal(res.status, 302)
  assert.equal(res.headers.get('Location'), '/ja/')
})

test('a visitor from anywhere else lands on the English page', async () => {
  for (const country of ['US', 'GB', 'DE', 'KR']) {
    assert.equal((await visit('/', { country })).headers.get('Location'), '/en/')
  }
  assert.equal((await visit('/')).headers.get('Location'), '/en/', 'no country known')
})

test('a language chosen on the page beats the country', async () => {
  assert.equal((await visit('/', { country: 'JP', cookie: 'a=1; hm_lang=en' })).headers.get('Location'), '/en/')
  assert.equal((await visit('/', { country: 'US', cookie: 'hm_lang=de' })).headers.get('Location'), '/de/')
  assert.equal((await visit('/', { country: 'JP', cookie: 'hm_lang=xx' })).headers.get('Location'), '/ja/', 'an unknown choice is ignored')
})

test('an old ?lang= link still goes where it said, for good', async () => {
  const res = await visit('/?lang=fr&utm_source=x', { country: 'JP' })
  assert.equal(res.status, 301)
  assert.equal(res.headers.get('Location'), '/fr/?utm_source=x')
})

test('the redirect is never cached for someone else', async () => {
  const res = await visit('/', { country: 'JP' })
  assert.match(res.headers.get('Cache-Control'), /private/)
  assert.equal(res.headers.get('Vary'), 'Cookie')
})

test('everything but the root is left to the static files', async () => {
  assert.equal(await (await visit('/ja/')).text(), 'asset /ja/')
  assert.equal(await (await visit('/main.js')).text(), 'asset /main.js')
})

test('with its own domain, the other addresses send people there', async () => {
  const site = makeWorker('honmaruai.com')
  const go = (url) => site.fetch({ url, headers: new Headers(), cf: { country: 'JP' } }, env)
  for (const from of ['https://honmaru-lp.pages.dev/ja/?utm_source=x', 'https://www.honmaruai.com/ja/?utm_source=x']) {
    const res = await go(from)
    assert.equal(res.status, 301, from)
    assert.equal(res.headers.get('Location'), 'https://honmaruai.com/ja/?utm_source=x')
  }
  assert.equal((await go('https://honmaruai.com/')).headers.get('Location'), '/ja/', 'the domain itself picks a language')
  assert.equal(await (await go('https://honmaruai.com/ja/')).text(), 'asset /ja/')
  assert.equal(await (await go('https://abc123.honmaru-lp.pages.dev/ja/')).text(), 'asset /ja/', 'a preview stays a preview')
})

test('without a domain of its own, pages.dev is the site', async () => {
  assert.equal(await (await visit('/ja/')).text(), 'asset /ja/')
})
