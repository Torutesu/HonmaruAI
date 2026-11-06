export type ExternalThreadGrant = {
  id: string
  permission: 'view' | 'edit'
  recipient: { name: string; email: string }
  grantedAt: string
  expiresAt: string | null
}

export type ExternalThreadShareInput = {
  email: string
  permission: 'view' | 'edit'
  expiresAt: string | null
}

export class ExternalThreadShareError extends Error {
  constructor(message: string, readonly status: number) { super(message) }
}

type Client = { httpBase: string; orgId: string; sessionToken: string }
const pathFor = (api: Client, threadId: string) =>
  `${api.httpBase.replace(/\/$/, '')}/external/threads/${encodeURIComponent(api.orgId)}/${encodeURIComponent(threadId)}/shares`

async function request<T>(api: Client, threadId: string, method: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const response = await fetch(pathFor(api, threadId), {
    method,
    headers: { 'x-session-token': api.sessionToken, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal,
    cache: 'no-store',
  })
  const value = await response.json().catch(() => null)
  if (!response.ok) throw new ExternalThreadShareError(value?.message || 'Could not update Thread access.', response.status)
  if (!value || typeof value !== 'object') throw new ExternalThreadShareError('The sharing service returned an invalid response.', response.status)
  return value as T
}

export async function listExternalThreadShares(api: Client, threadId: string, signal?: AbortSignal): Promise<ExternalThreadGrant[]> {
  const value = await request<{ shares?: ExternalThreadGrant[] }>(api, threadId, 'GET', undefined, signal)
  if (!Array.isArray(value.shares)) throw new ExternalThreadShareError('The sharing service returned an invalid list.', 502)
  return value.shares
}

export async function shareExternalThread(api: Client, threadId: string, input: ExternalThreadShareInput): Promise<ExternalThreadGrant> {
  const value = await request<{ recipient: ExternalThreadGrant['recipient']; grant: { id: string; permission: 'view'|'edit'; expiresAt: string|null } }>(api, threadId, 'POST', input)
  if (!value.grant?.id || !value.recipient?.email) throw new ExternalThreadShareError('The sharing service returned an invalid grant.', 502)
  return {
    id: value.grant.id,
    permission: value.grant.permission,
    expiresAt: value.grant.expiresAt,
    recipient: value.recipient,
    grantedAt: new Date().toISOString(),
  }
}

export async function revokeExternalThreadShare(api: Client, threadId: string, email: string): Promise<boolean> {
  const value = await request<{ revoked?: boolean }>(api, threadId, 'DELETE', { email })
  return value.revoked === true
}
