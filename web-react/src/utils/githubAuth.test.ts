import { describe, it, expect, beforeEach, vi } from 'vitest'
import { finishGitHubSignIn, readCallback } from './githubAuth'

function fakeStorage(): Storage {
  const m = new Map<string, string>()
  return {
    getItem: (k) => (m.has(k) ? m.get(k)! : null),
    setItem: (k, v) => { m.set(k, String(v)) },
    removeItem: (k) => { m.delete(k) },
    clear: () => m.clear(),
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size },
  } as Storage
}

// The way back from GitHub is trusted only when this browser started it.
describe('GitHub sign-in callback', () => {
  const g = globalThis as { localStorage?: Storage; location?: unknown; history?: unknown; fetch?: unknown }
  beforeEach(() => {
    g.localStorage = fakeStorage()
    g.location = { href: 'https://app.example/?code=abc&state=xyz#/feed', origin: 'https://app.example', pathname: '/' }
    g.history = { replaceState: () => {} }
  })

  it('reads the code and state off the page', () => {
    expect(readCallback()).toEqual({ code: 'abc', state: 'xyz' })
  })

  it('refuses a callback this browser did not start, even with nothing stored', async () => {
    g.fetch = vi.fn()
    await expect(finishGitHubSignIn('https://relay.example', { code: 'abc', state: 'xyz' })).rejects.toThrow(/did not start in this browser/)
    localStorage.setItem('oauthState', 'other')
    await expect(finishGitHubSignIn('https://relay.example', { code: 'abc', state: 'xyz' })).rejects.toThrow(/did not start in this browser/)
    expect(g.fetch).not.toHaveBeenCalled()
  })

  it('trades the code for a session when the state is the one it minted', async () => {
    localStorage.setItem('oauthState', 'xyz')
    const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ sessionToken: 'tok', login: 'toru', orgs: ['acme/shop'] }) }))
    g.fetch = fetch
    const out = await finishGitHubSignIn('https://relay.example', { code: 'abc', state: 'xyz' })
    expect(out).toEqual({ sessionToken: 'tok', login: 'toru', orgs: ['acme/shop'] })
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://relay.example/oauth/github/token')
    expect(JSON.parse(String(init.body))).toMatchObject({ code: 'abc', state: 'xyz', redirectUri: 'https://app.example/' })
    // Single use: the nonce is gone whatever happened.
    expect(localStorage.getItem('oauthState')).toBeNull()
  })
})
