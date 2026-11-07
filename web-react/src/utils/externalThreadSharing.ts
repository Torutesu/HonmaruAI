export type ExternalThreadGrant = {
  id: string
  permission: 'view' | 'edit'
  recipient: { name: string; email: string }
  grantedAt: string
  expiresAt: string | null
  recipientIsMember?: boolean
  suspended?: boolean
}

export type ExternalThreadInvitation = {
  id: string
  email: string
  permission: 'view' | 'edit'
  createdAt: string
  expiresAt: string
  accessExpiresAt: string | null
}

export type ExternalThreadInvitationInput = {
  email: string
  permission: 'view' | 'edit'
  accessExpiresAt: string | null
}

export type ExternalThreadSendRequest = {
  id: string
  body: string
  requested_at: string
  guest_name: string | null
  guest_email: string | null
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
const pathFor = (api: Client, threadId: string, suffix = 'shares') =>
  `${api.httpBase.replace(/\/$/, '')}/external/threads/${encodeURIComponent(api.orgId)}/${encodeURIComponent(threadId)}/${suffix}`

async function request<T>(api: Client, threadId: string, method: string, body?: unknown, signal?: AbortSignal, suffix = 'shares'): Promise<T> {
  const response = await fetch(pathFor(api, threadId, suffix), {
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

export async function revokeExternalThreadShare(api: Client, threadId: string, grantId: string): Promise<boolean> {
  const value = await request<{ revoked?: boolean }>(api, threadId, 'DELETE', { grantId })
  return value.revoked === true
}

export async function listExternalThreadInvitations(api: Client, threadId: string, signal?: AbortSignal): Promise<ExternalThreadInvitation[]> {
  const value = await request<{ invitations?: ExternalThreadInvitation[] }>(api,threadId,'GET',undefined,signal,'invites')
  if (!Array.isArray(value.invitations)) throw new ExternalThreadShareError('The invitation service returned an invalid list.',502)
  return value.invitations
}

export async function createExternalThreadInvitation(api: Client, threadId: string, input: ExternalThreadInvitationInput): Promise<{ invitationId:string; inviteUrl:string; expiresAt:string; emailDelivery:'sent'|'failed'|'not_configured' }> {
  const value = await request<{ invited?:boolean; invitationId?:string; inviteUrl?:string|null; token?:string; expiresAt?:string; emailDelivery?:{status?:'sent'|'failed'|'not_configured'} }>(api,threadId,'POST',input,undefined,'invites')
  let inviteUrl=value.inviteUrl||''
  if(!inviteUrl&&value.token){
    const url=new URL(window.location.href)
    url.hash=`#/external-invite/${value.token}`
    inviteUrl=url.toString()
  }
  if(!value.invited||!value.invitationId||!inviteUrl||!value.expiresAt) throw new ExternalThreadShareError('The invitation service returned an invalid invitation.',502)
  return {invitationId:value.invitationId,inviteUrl,expiresAt:value.expiresAt,emailDelivery:value.emailDelivery?.status||'not_configured'}
}

export async function revokeExternalThreadInvitation(api: Client, threadId: string, invitationId: string): Promise<boolean> {
  const value=await request<{revoked?:boolean}>(api,threadId,'DELETE',undefined,undefined,`invites/${encodeURIComponent(invitationId)}`)
  return value.revoked===true
}

export async function listExternalThreadSendRequests(api: Client, threadId: string, signal?: AbortSignal): Promise<ExternalThreadSendRequest[]> {
  const value = await request<{ requests?: ExternalThreadSendRequest[] }>(api, threadId, 'GET', undefined, signal, 'requests')
  if (!Array.isArray(value.requests)) throw new ExternalThreadShareError('The request service returned an invalid list.', 502)
  return value.requests
}

export async function decideExternalThreadSendRequest(api: Client, threadId: string, requestId: string, decision: 'approve' | 'reject'): Promise<void> {
  await request<{ approved?: boolean; rejected?: boolean }>(api, threadId, 'POST', { requestId }, undefined, `requests/${decision}`)
}
