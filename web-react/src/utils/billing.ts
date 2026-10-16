import { readResponse } from './api'

export interface BillingStatus {
  plan: string
  pro: boolean
  purchasable: boolean
  webPurchasable: boolean
  accessSource: 'complimentary' | 'subscription' | 'workspace' | 'free'
  /// The workspace runs on its own OpenAI key, so nothing here is metered.
  workspaceKey: boolean
  complimentary: boolean
  complimentarySyncPending: boolean
  complimentaryAvailable: boolean
  dailyLimit: number
  usedToday: number
  remainingToday: number | null
}

function statusFrom(body: Record<string, unknown>): BillingStatus {
  if (typeof body.pro !== 'boolean' || typeof body.purchasable !== 'boolean' ||
      typeof body.dailyLimit !== 'number' || typeof body.usedToday !== 'number' ||
      !(body.remainingToday === null || typeof body.remainingToday === 'number')) {
    throw new Error('Could not load plans.')
  }
  // Older deployments can still display their plan while redemption rolls out.
  const complimentary = body.pro && body.complimentary === true
  return {
    plan: body.pro ? 'pro' : 'free',
    pro: body.pro,
    purchasable: body.purchasable,
    webPurchasable: body.webPurchasable === true,
    accessSource: complimentary ? 'complimentary' : body.pro ? 'subscription' : body.workspaceKey === true ? 'workspace' : 'free',
    workspaceKey: body.workspaceKey === true,
    complimentary,
    complimentarySyncPending: complimentary && body.complimentarySyncPending === true,
    complimentaryAvailable: body.complimentaryAvailable === true,
    dailyLimit: body.dailyLimit,
    usedToday: body.usedToday,
    remainingToday: body.remainingToday,
  }
}

export class AccessCodeError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

export async function loadBillingStatus(base: string, token: string, signal: AbortSignal, orgId?: string): Promise<BillingStatus> {
  const response = await fetch(`${base}/billing/status${orgId ? `?orgId=${encodeURIComponent(orgId)}` : ''}`, {
    headers: { 'x-session-token': token },
    cache: 'no-store',
    signal,
  })
  if (!response.ok) throw new Error('Could not load plans.')
  return statusFrom(await readResponse(response))
}

export async function redeemAccessCode(base: string, token: string, input: string, signal: AbortSignal): Promise<BillingStatus> {
  const code = input.trim()
  if (!code || code.length > 128) throw new Error('Enter a valid access code.')
  const response = await fetch(`${base}/billing/redeem`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-session-token': token },
    body: JSON.stringify({ code }),
    cache: 'no-store',
    signal,
  })
  if (!response.ok) {
    // A durable grant can outlive a temporary App Store sync outage. The
    // server explicitly reports both; never render its arbitrary message.
    if (response.status === 503) {
      const body = await response.json().catch(() => null)
      if (body?.complimentary === true && body?.complimentarySyncPending === true) {
        try {
          const pending = statusFrom(body)
          if (pending.complimentary) return pending
        } catch { /* A partial reply is still an unavailable service. */ }
      }
    }
    // Do not render arbitrary response text that could echo a private code.
    const message = response.status === 400 ? 'That access code is not valid.'
      : response.status === 401 ? 'Please sign in again to activate free access.'
      : response.status === 429 ? 'Too many attempts. Wait a moment and try again.'
      : response.status === 503 ? 'Access codes are currently unavailable. Try again later.'
      : 'Could not activate free access. Try again.'
    throw new AccessCodeError(message, response.status)
  }
  const status = statusFrom(await readResponse(response))
  if (!status.complimentary) throw new Error('Could not activate free access. Try again.')
  return status
}

export async function openBillingLink(base: string, token: string, action: 'checkout' | 'manage', signal: AbortSignal): Promise<string> {
  const response = await fetch(`${base}/billing/${action === 'checkout' ? 'web-checkout' : 'manage'}`, {
    method: 'POST', headers: { 'x-session-token': token }, cache: 'no-store', signal,
  })
  if (!response.ok) throw new Error(response.status === 409
    ? 'Your account already has access, or this subscription must be managed with its original provider.'
    : 'Could not open billing. Please try again.')
  const body = await readResponse(response)
  const url = new URL(String(body.url))
  const hosts = action === 'checkout' ? ['pay.rev.cat'] : ['billing.stripe.com', 'billing.revenuecat.com', 'apps.apple.com', 'play.google.com']
  if (url.protocol !== 'https:' || url.username || url.password || !hosts.includes(url.hostname)) throw new Error('Could not open billing. Please try again.')
  return url.href
}
