// One way every client talks to the Worker: the base address, the session
// token, JSON both ways, and an error that says what the server said.

import type {
  AppleSignIn, Business, DeviceRegistration, HistoryQuery, HistoryResponse, InviteAccepted, Me, OtpRequest, OtpVerify, PostResponse, SearchResponse, SignedIn, UnreadResponse,
} from '../../protocol/src/index'
import { v2Paths } from '../../protocol/src/v2'

export class ApiError extends Error {
  constructor(readonly status: number, message: string, readonly retryAfter: number | null = null) {
    super(message)
    this.name = 'ApiError'
  }
}

/// Whether a failed call means the session itself is over: the server no
/// longer knows it (401), or its account is gone (409). Anything else — no
/// network yet after a restart, a timeout, the server having a bad moment —
/// says nothing about the session, and must never sign anyone out.
export function sessionEnded(err: unknown): boolean {
  return err instanceof ApiError && (err.status === 401 || err.status === 409)
}

export interface ApiOptions {
  base: string
  /// The session token, read on every call so signing in or out takes effect at once.
  token?: () => string | null | undefined
  fetch?: typeof fetch
}

export class Api {
  private readonly base: string
  private readonly token: () => string | null | undefined
  private readonly doFetch: typeof fetch

  constructor(options: ApiOptions) {
    this.base = options.base.replace(/\/$/, '')
    this.token = options.token || (() => null)
    this.doFetch = options.fetch || ((...args) => fetch(...args))
  }

  async request<T>(path: string, init: { method?: string; body?: unknown; query?: Record<string, string | number | undefined | null> } = {}): Promise<T> {
    const q = Object.entries(init.query || {}).filter(([, v]) => v !== undefined && v !== null)
    const url = `${this.base}${path}${q.length ? `?${new URLSearchParams(q.map(([k, v]) => [k, String(v)])).toString()}` : ''}`
    const headers: Record<string, string> = {}
    if (init.body !== undefined) headers['content-type'] = 'application/json'
    const token = this.token()
    if (token) headers['x-session-token'] = token
    const res = await this.doFetch(url, { method: init.method || 'GET', headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) })
    const text = await res.text()
    let data: unknown = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    if (!res.ok) {
      const message = (data && typeof data === 'object' && 'message' in data && typeof (data as { message: unknown }).message === 'string')
        ? (data as { message: string }).message
        : `The server answered ${res.status}.`
      const retry = Number(res.headers.get('retry-after'))
      throw new ApiError(res.status, message, Number.isFinite(retry) && retry > 0 ? retry : null)
    }
    return data as T
  }

  // ---- Signing in ----
  requestCode(body: OtpRequest) { return this.request<{ ok?: boolean }>('/auth/otp/request', { method: 'POST', body }) }
  verifyCode(body: OtpVerify) { return this.request<SignedIn>('/auth/otp/verify', { method: 'POST', body }) }
  signInWithApple(body: AppleSignIn) { return this.request<SignedIn>('/auth/apple', { method: 'POST', body }) }
  acceptInvite(code: string) { return this.request<InviteAccepted>('/invites/accept', { method: 'POST', body: { code } }) }
  me() { return this.request<Me>('/me') }
  businesses(orgId: string) { return this.request<{ businesses: Business[] }>('/businesses', { query: { orgId } }) }

  // ---- Push ----
  /// This phone's native push token, for whoever is signed in. Sent again on
  /// every launch: Apple and Google reissue tokens, and the server keeps one
  /// row per token, moved to the newest account that registered it.
  registerDevice(body: DeviceRegistration) { return this.request<{ ok: true }>('/devices', { method: 'POST', body }) }
  /// Forget this phone before signing out, while the session still says whose it is.
  unregisterDevice(deviceToken: string) { return this.request<{ ok: true }>('/devices', { method: 'DELETE', body: { deviceToken } }) }

  // ---- Conversations (v2) ----
  history(orgId: string, channel: string, query: HistoryQuery = {}) {
    return this.request<HistoryResponse>(v2Paths.messages(orgId, channel), { query: { ...query } })
  }
  post(orgId: string, channel: string, body: string, parentId?: string, alsoChannel = false) {
    return this.request<PostResponse>(v2Paths.messages(orgId, channel), {
      method: 'POST', body: { body, ...(parentId ? { parentId, ...(alsoChannel ? { alsoChannel: true } : {}) } : {}) },
    })
  }
  markRead(orgId: string, channel: string, seq: number) {
    return this.request<{ ok: true }>(v2Paths.read(orgId, channel), { method: 'POST', body: { seq } })
  }
  unread(orgId: string, channels: string[]) {
    return this.request<UnreadResponse>(v2Paths.unread(orgId), { method: 'POST', body: { channels } })
  }
  search(orgId: string, q: string, channels: string[]) {
    return this.request<SearchResponse>(v2Paths.search(orgId), { query: { q, channels: channels.join(',') } })
  }
}
