import { describe, it, expect, beforeEach } from 'vitest'
import { bindSsoStart, boundSsoStart, discardSsoStart, takeSsoVerifier, takeSsoVerifierForCurrentSession } from './ssoBinding'

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

  it('does not create an SSO verifier if the account changes during preparation', async () => {
    storage.setItem('sessionToken','old');storage.setItem('userId','alice')
    let current=true
    const pending=boundSsoStart('https://api.example','/sso/start',storage,()=>current)
    storage.setItem('sessionToken','new');storage.setItem('userId','bob');current=false
    await expect(pending).rejects.toThrow('Session changed')
    expect(storage.getItem('sso.pending')).toBeNull()
  })

  it('only accepts a returning verifier for the session that started it', async () => {
    storage.setItem('sessionToken','old');storage.setItem('userId','alice')
    const bind=await bindSsoStart(storage)
    storage.setItem('sessionToken','new');storage.setItem('userId','bob')
    expect(await takeSsoVerifierForCurrentSession(storage)).toBeNull()
    storage.setItem('sessionToken','old');storage.setItem('userId','alice')
    const verifier=await takeSsoVerifierForCurrentSession(storage)
    expect(await hash(verifier!)).toBe(bind)
    expect(await takeSsoVerifierForCurrentSession(storage)).toBeNull()
  })

  it('does not let a stale start discard a newer verifier',async()=>{
    const first=await boundSsoStart('https://api.example','/sso/start',storage)
    const second=await boundSsoStart('https://api.example','/sso/start',storage)
    discardSsoStart(first,storage)
    const verifier=await takeSsoVerifierForCurrentSession(storage)
    expect(await hash(verifier!)).toBe(new URL(second).searchParams.get('bind'))
  })

  it('refuses legacy pending verifiers with no recorded starting session',async()=>{
    storage.setItem('sso.pending',JSON.stringify({verifier:'old-verifier',at:Date.now()}))
    expect(await takeSsoVerifierForCurrentSession(storage)).toBeNull()
  })
})
