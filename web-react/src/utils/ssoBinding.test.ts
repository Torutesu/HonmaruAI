import { describe, it, expect, beforeEach } from 'vitest'
import { bindSsoStart, boundSsoStart, takeSsoVerifier } from './ssoBinding'

// A single sign-on is finished only in the browser that started it.
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

const hash = async (verifier: string) => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier)))))
  .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')

describe('a sign-in bound to this browser', () => {
  let storage: Storage
  beforeEach(() => { storage = fakeStorage() })

  it('sends only the hash of the secret it keeps, and gives the secret back once', async () => {
    const bind = await bindSsoStart(storage)
    expect(bind).toMatch(/^[A-Za-z0-9_-]{43}$/)
    const verifier = takeSsoVerifier(storage)
    expect(verifier).toBeTruthy()
    expect(await hash(verifier!)).toBe(bind)
    expect(bind).not.toContain(verifier!)
    // Once: a second completion of the same sign-in has nothing to trade.
    expect(takeSsoVerifier(storage)).toBeNull()
  })

  it('has nothing to finish a sign-in it never started with', () => {
    expect(takeSsoVerifier(storage)).toBeNull()
  })

  it('lets a sign-in started long ago lapse', async () => {
    const started = Date.parse('2026-10-18T09:00:00Z')
    await bindSsoStart(storage, started)
    expect(takeSsoVerifier(storage, started + 11 * 60_000)).toBeNull()
    await bindSsoStart(storage, started)
    expect(takeSsoVerifier(storage, started + 60_000)).toBeTruthy()
  })

  it('adds the binding to the start address, with or without a query already', async () => {
    expect(await boundSsoStart('https://api.example', '/sso/start?orgId=team%3Aa&client=web', storage)).toMatch(/^https:\/\/api\.example\/sso\/start\?orgId=team%3Aa&client=web&bind=[A-Za-z0-9_-]{43}$/)
    expect(await boundSsoStart('https://api.example', '/sso/start', storage)).toMatch(/\/sso\/start\?bind=/)
  })
})
