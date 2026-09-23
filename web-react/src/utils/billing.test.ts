import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadBillingStatus, redeemAccessCode } from './billing'

const free = { pro: false, purchasable: true, dailyLimit: 3, usedToday: 1, remainingToday: 2 }
const granted = { ...free, pro: true, remainingToday: null, complimentary: true, complimentaryAvailable: true }
const signal = () => new AbortController().signal
afterEach(() => { vi.unstubAllGlobals() })

describe('Account billing requests', () => {
  it('reads older status without inventing an available code or price', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ...free, trialDays: 3, currency: 'USD', plans: [{ id: 'business', monthly: 15 }] })))
    vi.stubGlobal('fetch', fetcher)
    const abort = signal()
    const status = await loadBillingStatus('https://api.example', 'account-a', abort)
    expect(status).toMatchObject({ pro: false, complimentaryAvailable: false, accessSource: 'free' })
    expect(status).not.toHaveProperty('trialDays')
    expect(status).not.toHaveProperty('plans')
    expect(fetcher).toHaveBeenCalledWith('https://api.example/billing/status', {
      headers: { 'x-session-token': 'account-a' }, cache: 'no-store', signal: abort,
    })
  })

  it('sends a code only in the authenticated POST body and confirms the server grant', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(JSON.stringify(granted)))
    vi.stubGlobal('fetch', fetcher)
    const abort = signal()
    await expect(redeemAccessCode('https://api.example', 'account-a', '  private-fixture  ', abort))
      .resolves.toMatchObject({ pro: true, complimentary: true, accessSource: 'complimentary' })
    expect(fetcher).toHaveBeenCalledWith('https://api.example/billing/redeem', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': 'account-a' },
      body: JSON.stringify({ code: 'private-fixture' }), cache: 'no-store', signal: abort,
    })
  })

  it('keeps a durable grant distinct from incomplete iPhone sync on HTTP 503', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ ...granted, complimentarySyncPending: true, message: 'private-fixture' }, { status: 503 })))
    await expect(redeemAccessCode('https://api.example', 'account-a', 'private-fixture', signal()))
      .resolves.toMatchObject({ pro: true, complimentary: true, complimentarySyncPending: true })
  })

  it('does not invent a grant from a partial pending response', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ complimentary: true, complimentarySyncPending: true, message: 'private-fixture' }, { status: 503 })))
    await expect(redeemAccessCode('https://api.example', 'account-a', 'private-fixture', signal()))
      .rejects.toThrow('Access codes are currently unavailable.')
  })

  it('updates a pending grant to synced only from a successful status read', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValueOnce(Response.json({ ...granted, complimentarySyncPending: true })).mockResolvedValueOnce(Response.json({ ...granted, complimentarySyncPending: false })))
    expect((await loadBillingStatus('https://api.example', 'account-a', signal())).complimentarySyncPending).toBe(true)
    expect((await loadBillingStatus('https://api.example', 'account-a', signal())).complimentarySyncPending).toBe(false)
  })

  it('never echoes a failed status response into the UI', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(Response.json({ message: 'private-fixture' }, { status: 503 })))
    await expect(loadBillingStatus('https://api.example', 'account-a', signal())).rejects.toThrow('Could not load plans.')
  })

  it('never makes a request for empty or oversized codes', async () => {
    const fetcher = vi.fn()
    vi.stubGlobal('fetch', fetcher)
    for (const input of ['  ', 'a'.repeat(129)]) {
      await expect(redeemAccessCode('https://api.example', 'account-a', input, signal())).rejects.toThrow('Enter a valid access code.')
    }
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each([
    [400, 'That access code is not valid.'],
    [401, 'Please sign in again to activate free access.'],
    [429, 'Too many attempts. Wait a moment and try again.'],
    [503, 'Access codes are currently unavailable. Try again later.'],
    [500, 'Could not activate free access. Try again.'],
  ])('handles HTTP %i without displaying echoed codes or server data', async (httpStatus, message) => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({ message: 'private-fixture' }), { status: httpStatus })))
    await expect(redeemAccessCode('https://api.example', 'account-a', 'private-fixture', signal())).rejects.toThrow(message)
  })

  it('does not report success for an unchanged free plan or a malformed response', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(free)))
      .mockResolvedValueOnce(new Response(JSON.stringify({ complimentary: true })))
    vi.stubGlobal('fetch', fetcher)
    await expect(redeemAccessCode('https://api.example', 'account-a', 'private-fixture', signal())).rejects.toThrow('Could not activate free access.')
    await expect(redeemAccessCode('https://api.example', 'account-a', 'private-fixture', signal())).rejects.toThrow('Could not load plans.')
  })
})
