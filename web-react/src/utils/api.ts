export function apiBase(configuredHost: string | undefined, page: { protocol: string; host: string }, development = false): string {
  const fallback = development ? 'localhost:8787' : page.host
  const input = (configuredHost || fallback).trim()
  const url = new URL(input.includes('://') ? input : `${page.protocol}//${input}`)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new Error('The API address must be an HTTP(S) origin, without a path or credentials.')
  }
  if (page.protocol === 'https:' && url.protocol !== 'https:') throw new Error('A secure page requires an HTTPS API address.')
  return url.origin
}

export async function readResponse(response: Response): Promise<Record<string, any>> {
  const body = await response.json().catch(() => null)
  if (!body || typeof body !== 'object') throw new Error('The service returned an unexpected response. Please try again.')
  if (!response.ok) throw new Error(body.message || `The request could not be completed (${response.status}).`)
  return body
}
