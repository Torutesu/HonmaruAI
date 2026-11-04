import React, { useCallback, useEffect, useState } from 'react'

import './McpConnections.css'

type Client = { id: string; name: string; redirectUris: string[] }
type Connection = { id: string; orgId: string; name: string; clientId: string; redirectOrigins: string[]; scopes: string[] }
type Scope = { name: string; title: string; description: string }
export function McpConnections({ httpBase, sessionToken, orgId }: { httpBase: string; sessionToken: string; orgId: string }) {
  const [clients, setClients] = useState<Client[]>([])
  const [connections, setConnections] = useState<Connection[]>([])
  const [scopes, setScopes] = useState<Scope[]>([])
  const [resource, setResource] = useState('')
  const [name, setName] = useState('')
  const [redirects, setRedirects] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const refresh = useCallback(async (signal?: AbortSignal) => {
    const headers = { 'x-session-token': sessionToken }
    const responses = await Promise.all(['clients', 'connections', 'scopes'].map(path => fetch(`${httpBase}/mcp/oauth/${path}`, { headers, signal })))
    if (responses.some(response => !response.ok)) throw new Error('Could not load MCP connections.')
    const [apps, grants, permissions] = await Promise.all(responses.map(response => response.json()))
    if (signal?.aborted) return
    setClients(apps.clients); setResource(apps.resource); setConnections(grants.connections); setScopes(permissions.scopes)
  }, [httpBase, sessionToken])
  useEffect(() => {
    const controller = new AbortController()
    setClients([]); setConnections([]); setError('')
    void refresh(controller.signal).catch(error => { if (!controller.signal.aborted) setError(String(error.message)) })
    return () => controller.abort()
  }, [refresh])
  const mutate = async (path: string, method: string, data?: unknown) => {
    setBusy(true); setError('')
    try {
      const response = await fetch(`${httpBase}/mcp/oauth/${path}`, { method, headers: { 'x-session-token': sessionToken, 'content-type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) })
      const result = await response.json()
      if (!response.ok) throw new Error(result.error_description || result.message || 'The change could not be saved.')
      if (method === 'POST') { setName(''); setRedirects('') }
      await refresh()
    } catch (error) { setError(error instanceof Error ? error.message : 'The change could not be saved.') }
    finally { setBusy(false) }
  }
  return <section aria-label="MCP connections" className="studio-mcp-connections">
    <h3>Connected AI apps</h3>
    <p>Connect an MCP-compatible app to Honmaru over the internet. Each connection acts as you with the permissions you approve.</p>
    {error && <p role="alert">{error}</p>}
    {connections.filter(connection => connection.orgId === orgId).map(connection => <div key={connection.id} className="studio-token-row">
      <strong>{connection.name}</strong>
      <p>{connection.redirectOrigins.join(', ')}</p>
      <p>Client ID <code>{connection.clientId}</code></p>
      <p>{connection.scopes.map(scope => scopes.find(item => item.name === scope)?.title || scope).join(', ')}</p>
      <button className="studio-btn" disabled={busy} onClick={() => void mutate(`connections/${encodeURIComponent(connection.id)}`, 'DELETE')}>Disconnect {connection.name}</button>
    </div>)}
    {!connections.some(connection => connection.orgId === orgId) && <p>No connected AI apps in this workspace.</p>}
    <details>
      <summary>Register an MCP client</summary>
      <p>For app developers. Register the exact callback URL your app uses, then configure its OAuth client ID and this MCP endpoint.</p>
      <p><code>{resource}</code></p>
      <form onSubmit={event => { event.preventDefault(); void mutate('clients', 'POST', { name: name.trim(), redirectUris: redirects.split(/\r?\n/).map(value => value.trim()).filter(Boolean) }) }}>
        <label>App name<input value={name} onChange={event => setName(event.target.value)} maxLength={100} required /></label>
        <label>Callback URLs, one per line<textarea value={redirects} onChange={event => setRedirects(event.target.value)} required rows={3} /></label>
        <p>Use HTTPS callbacks, or an HTTP loopback address for a local app. Public clients must use PKCE with S256. No client secret is issued.</p>
        <button className="studio-btn primary" disabled={busy}>Register app</button>
      </form>
      {clients.map(client => <div key={client.id}>
        <strong>{client.name}</strong><p>Client ID <code>{client.id}</code></p>
        <p>{client.redirectUris.join(', ')}</p>
        <button className="studio-btn" disabled={busy} onClick={() => void mutate(`clients/${encodeURIComponent(client.id)}`, 'DELETE')}>Revoke app and its connections</button>
      </div>)}
    </details>
  </section>
}
