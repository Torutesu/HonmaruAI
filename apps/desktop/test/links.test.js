import { describe, it, expect } from 'vitest'
import { deepLinkToHash, deepLinkToUrl, linkFromArgv, isSafeExternal, navigationDecision, windowTitle, SIGN_IN_MS } from '../src/links.js'

const APP = 'https://app.honmaruai.com/'
const API = 'https://tiktokforwork.torubj0904.workers.dev'
const ORIGINS = ['https://app.honmaruai.com', API, 'https://github.com']

describe('honmaru:// links', () => {
  it('open a conversation in its workspace, and an invitation, at the web app\'s own paths', () => {
    expect(deepLinkToUrl('honmaru://c/b%3Ageneral?org=team%3Aacme', APP)).toBe('https://app.honmaruai.com/c/b%3Ageneral?org=team%3Aacme')
    expect(deepLinkToUrl('honmaru://c/dm:mika', APP)).toBe('https://app.honmaruai.com/c/dm:mika')
    expect(deepLinkToUrl('honmaru://join/0123456789abcdef', APP)).toBe('https://app.honmaruai.com/join/0123456789abcdef')
  })

  it('open the app at its start for anything else of ours, and nothing for other schemes', () => {
    expect(deepLinkToUrl('honmaru://settings', APP)).toBe('https://app.honmaruai.com/')
    // Dot segments are resolved by the URL parser: it never leaves the app,
    // and the web app refuses "etc" as a channel.
    expect(new URL(deepLinkToUrl('honmaru://c/../../etc', APP)).origin).toBe('https://app.honmaruai.com')
    expect(deepLinkToUrl('https://evil.example/c/x', APP)).toBeNull()
    expect(deepLinkToUrl('not a url', APP)).toBeNull()
  })

  it('never carry a workspace onto an invitation', () => {
    expect(deepLinkToUrl('honmaru://join/abc?org=x', APP)).toBe('https://app.honmaruai.com/join/abc')
  })

  it('move an app that is already open by its hash route, the web\'s own (webHashFor)', () => {
    expect(deepLinkToHash('honmaru://c/b%3Ageneral?org=team%3Aacme')).toBe('#/c/b%3Ageneral?org=team%3Aacme')
    expect(deepLinkToHash('honmaru://c/dm:mika')).toBe('#/c/dm%3Amika')
    expect(deepLinkToHash('honmaru://join/0123456789abcdef?org=x')).toBe('#/join/0123456789abcdef')
    // Nothing to move to: the window is only shown.
    expect(deepLinkToHash('honmaru://settings')).toBeNull()
    expect(deepLinkToHash('honmaru://c/')).toBeNull()
    expect(deepLinkToHash('https://app.honmaruai.com/c/b%3Ax')).toBeNull()
    expect(deepLinkToHash('not a url')).toBeNull()
  })

  it('cannot break out of the hash they set', () => {
    // Whatever the link carries is encoded into one hash segment.
    expect(deepLinkToHash("honmaru://c/b%3Ax'%22;alert(1)//")).toBe("#/c/b%3Ax'%22%3Balert(1)%2F%2F")
    expect(deepLinkToHash('honmaru://c/%E0%A4%A')).toBe('#/c/%25E0%25A4%25A')
  })

  it('are found among a second start\'s arguments', () => {
    expect(linkFromArgv(['C:\\Honmaru.exe', '--flag', 'honmaru://c/b%3Ax'])).toBe('honmaru://c/b%3Ax')
    expect(linkFromArgv(['C:\\Honmaru.exe'])).toBeNull()
  })
})

describe('where the window may go', () => {
  const decide = (target, extra = {}) => navigationDecision({ target, from: APP, origins: ORIGINS, apiOrigins: [API], now: 1000, ...extra })

  it('stays on the app, the API and GitHub', () => {
    expect(decide('https://app.honmaruai.com/#/list')).toMatchObject({ allow: true })
    expect(decide(`${API}/auth/github`)).toMatchObject({ allow: true })
    expect(decide('https://github.com/login/oauth/authorize?x=1')).toMatchObject({ allow: true })
  })

  it('sends any other page to the browser', () => {
    expect(decide('https://news.example/story')).toEqual({ allow: false, external: true, signIn: null })
  })

  it('lets a sign-in the API sent to an identity provider run its course there, then ends it back on the app', () => {
    const started = decide('https://login.company.example/saml', { from: `${API}/sso/start?orgId=x`, redirect: true })
    const signIn = { origin: 'https://login.company.example', until: 1000 + SIGN_IN_MS }
    expect(started).toEqual({ allow: true, external: false, signIn })
    // The identity provider's own pages, on its own origin.
    expect(decide('https://login.company.example/mfa/push', { signIn, now: 5000 })).toEqual({ allow: true, external: false, signIn })
    // The way back: the API, then the app, which ends the sign-in.
    expect(decide(`${API}/sso/callback?code=x`, { signIn })).toEqual({ allow: true, external: false, signIn: null })
    expect(decide('https://app.honmaruai.com/#/sso/done?code=x', { signIn })).toEqual({ allow: true, external: false, signIn: null })
  })

  it('allows only the one origin the API redirected to, not any https site', () => {
    const signIn = { origin: 'https://login.company.example', until: 1000 + SIGN_IN_MS }
    expect(decide('https://news.example/story', { signIn, now: 5000 })).toEqual({ allow: false, external: true, signIn })
    expect(decide('https://evil.login.company.example/', { signIn, now: 5000 })).toMatchObject({ allow: false, external: true })
    expect(decide('https://login.company.example.evil.example/', { signIn, now: 5000 })).toMatchObject({ allow: false, external: true })
    // Plain http, even to that origin's host, never loads.
    expect(decide('http://login.company.example/', { signIn, now: 5000 })).toMatchObject({ allow: false })
  })

  it('does not last: a few minutes, then the identity provider opens in the browser', () => {
    expect(SIGN_IN_MS).toBeLessThanOrEqual(5 * 60 * 1000)
    const signIn = { origin: 'https://login.company.example', until: 1000 + SIGN_IN_MS }
    expect(decide('https://login.company.example/mfa', { signIn, now: signIn.until + 1 })).toMatchObject({ allow: false, external: true })
  })

  it('moves the allowance when the API redirects again, rather than adding to it', () => {
    const signIn = { origin: 'https://login.company.example', until: 1000 + SIGN_IN_MS }
    const again = decide('https://idp.other.example/', { from: `${API}/sso/start`, redirect: true, signIn, now: 2000 })
    expect(again.signIn).toEqual({ origin: 'https://idp.other.example', until: 2000 + SIGN_IN_MS })
    expect(decide('https://login.company.example/', { signIn: again.signIn, now: 3000 })).toMatchObject({ allow: false })
  })

  it('does not open a sign-in for a redirect that did not come from the API, or for plain http', () => {
    expect(decide('https://login.company.example/', { from: 'https://news.example/', redirect: true })).toMatchObject({ allow: false, external: true })
    expect(decide('https://login.company.example/', { from: API, redirect: false })).toMatchObject({ allow: false })
    expect(decide('http://login.company.example/', { from: API, redirect: true })).toMatchObject({ allow: false })
  })

  it('never loads other schemes, and hands only web and mail links to the system', () => {
    expect(decide('file:///C:/Windows/system32')).toEqual({ allow: false, external: false, signIn: null })
    expect(decide('mailto:hi@example.com')).toEqual({ allow: false, external: true, signIn: null })
    expect(isSafeExternal('javascript:alert(1)')).toBe(false)
    expect(isSafeExternal('ms-settings:privacy')).toBe(false)
    expect(isSafeExternal('https://example.com')).toBe(true)
  })
})

describe('the window\'s title', () => {
  const title = (url, pageTitle) => windowTitle({ url, appOrigin: 'https://app.honmaruai.com', pageTitle })

  it('is the page\'s own on the app, with its count', () => {
    expect(title('https://app.honmaruai.com/#/list', '(3) Honmaru AI')).toBe('(3) Honmaru AI')
    expect(title('https://app.honmaruai.com/', '')).toBe('Honmaru AI')
  })

  it('names the site anywhere else, since there is no address bar', () => {
    expect(title('https://login.company.example/saml?x=1', 'Sign in to Contoso')).toBe('Honmaru AI — signing in at login.company.example')
    expect(title('https://github.com/login', 'Sign in')).toBe('Honmaru AI — signing in at github.com')
  })
})

describe('the Go menu', () => {
  it('names each place by a hash route the web app answers, in the system language', async () => {
    const { goMenuItems } = await import('../src/links.js')
    const items = goMenuItems('ja-JP').filter((i) => !i.type)
    expect(items.map((i) => i.hash)).toEqual(['#/feed', '#/history', '#/tools', '#/harness', '#/apps', '#/workflows', '#/approvals'])
    expect(items.find((i) => i.hash === '#/harness')).toMatchObject({ label: 'ハーネス', accelerator: 'CmdOrCtrl+Shift+H' })
    expect(goMenuItems('en-US')[0].label).toBe('Feed')
    // No two places share a shortcut.
    const keys = items.map((i) => i.accelerator).filter(Boolean)
    expect(new Set(keys).size).toBe(keys.length)
  })
})
