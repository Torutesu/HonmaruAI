export type ExternalThreadAccess = { orgId: string; rootId: string; permission: 'view' | 'edit' }

/** Extract only the exact guest resource granted by a successful redemption. */
export function externalThreadAccessFromInvite(value: unknown): ExternalThreadAccess | null {
  if (!value || typeof value !== 'object') return null
  const result=value as Record<string,unknown>
  if (result.redeemed !== true || result.resourceType !== 'thread' ||
      typeof result.orgId !== 'string' || !result.orgId ||
      typeof result.resourceId !== 'string' || !result.resourceId ||
      (result.permission !== 'view' && result.permission !== 'edit')) return null
  return {orgId:result.orgId,rootId:result.resourceId,permission:result.permission}
}

/** Build the browser route for the exact granted Thread. */
export function externalThreadHash(access: ExternalThreadAccess): string {
  return `#/external-thread/${encodeURIComponent(access.orgId)}/${encodeURIComponent(access.rootId)}`
}
