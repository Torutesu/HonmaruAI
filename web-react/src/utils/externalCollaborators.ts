export type ExternalCollaborator = { githubId: string; login: string; name: string | null }

export async function searchExternalCollaborators(
  httpBase: string,
  sessionToken: string,
  input: { orgId: string; resourceType: 'thread' | 'app' | 'file'; resourceId: string; query: string },
  signal?: AbortSignal,
): Promise<ExternalCollaborator[]> {
  const params = new URLSearchParams({ ...input, q: input.query })
  params.delete('query')
  const response = await fetch(`${httpBase.replace(/\/$/, '')}/external/collaborators/search?${params}`, {
    headers: { 'x-session-token': sessionToken }, signal, cache: 'no-store',
  })
  const data = await response.json().catch(() => null)
  if (!response.ok) throw new Error(data?.message || `Could not search collaborators (${response.status}).`)
  return Array.isArray(data?.people) ? data.people.flatMap((person: unknown): ExternalCollaborator[] => {
    if (!person || typeof person !== 'object') return []
    const value = person as Partial<ExternalCollaborator>
    if (typeof value.githubId !== 'string' || typeof value.login !== 'string'
      || !(value.name === null || typeof value.name === 'string')) return []
    return [{githubId:value.githubId,login:value.login,name:value.name}]
  }) : []
}
