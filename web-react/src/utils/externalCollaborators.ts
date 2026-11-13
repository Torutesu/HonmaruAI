// Someone outside the workspace, as the search names them: a handle the
// share call takes back, a name, and a GitHub handle when they have one. An
// account id or a login made from an email address never reaches the browser.
export type ExternalCollaborator = { ref: string; name: string; login: string | null }

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
    if (typeof value.ref !== 'string' || typeof value.name !== 'string'
      || !(value.login === null || typeof value.login === 'string')) return []
    return [{ref:value.ref,name:value.name,login:value.login}]
  }) : []
}
