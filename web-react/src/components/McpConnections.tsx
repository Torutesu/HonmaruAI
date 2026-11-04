import React, { useCallback, useEffect, useState } from 'react'

import { useT } from '../utils/i18n'
import './McpConnections.css'

type Client = { id: string; name: string; redirectUris: string[] }
type Connection = { id: string; orgId: string; name: string; clientId: string; redirectOrigins: string[]; scopes: string[] }
type Scope = { name: string; title: string; description: string }
export function McpConnections({ httpBase, sessionToken, orgId }: { httpBase: string; sessionToken: string; orgId: string }) {
  const t = useT()
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
    if (responses.some(response => !response.ok)) throw new Error(t('Could not load MCP connections.'))
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
      if (!response.ok) throw new Error(result.error_description || result.message || t('The change could not be saved.'))
      if (method === 'POST') { setName(''); setRedirects('') }
      await refresh()
    } catch (error) { setError(error instanceof Error ? error.message : t('The change could not be saved.')) }
    finally { setBusy(false) }
  }
  return <section aria-label={t('MCP connections')} className="studio-mcp-connections">
    <h3>{t('Connected AI apps')}</h3>
    <p>{t('mcp.connections.lede')}</p>
    {error && <p role="alert">{error}</p>}
    {connections.filter(connection => connection.orgId === orgId).map(connection => <div key={connection.id} className="studio-token-row">
      <strong>{connection.name}</strong>
      <p>{connection.redirectOrigins.join(', ')}</p>
      <p>{t('Client ID')} <code>{connection.clientId}</code></p>
      <p>{connection.scopes.map(scope => t(scopes.find(item => item.name === scope)?.title || scope)).join(', ')}</p>
      <button className="studio-btn" disabled={busy} onClick={() => void mutate(`connections/${encodeURIComponent(connection.id)}`, 'DELETE')}>{t('Disconnect {app}', { app: connection.name })}</button>
    </div>)}
    {!connections.some(connection => connection.orgId === orgId) && <p>{t('No connected AI apps in this workspace.')}</p>}
    <details>
      <summary>{t('Register an MCP client')}</summary>
      <p>{t('mcp.register.lede')}</p>
      <p><code>{resource}</code></p>
      <form onSubmit={event => { event.preventDefault(); void mutate('clients', 'POST', { name: name.trim(), redirectUris: redirects.split(/\r?\n/).map(value => value.trim()).filter(Boolean) }) }}>
        <label>{t('App name')}<input value={name} onChange={event => setName(event.target.value)} maxLength={100} required /></label>
        <label>{t('Callback URLs, one per line')}<textarea value={redirects} onChange={event => setRedirects(event.target.value)} required rows={3} /></label>
        <p>{t('mcp.register.hint')}</p>
        <button className="studio-btn primary" disabled={busy}>{t('Register app')}</button>
      </form>
      {clients.map(client => <div key={client.id}>
        <strong>{client.name}</strong><p>{t('Client ID')} <code>{client.id}</code></p>
        <p>{client.redirectUris.join(', ')}</p>
        <button className="studio-btn" disabled={busy} onClick={() => void mutate(`clients/${encodeURIComponent(client.id)}`, 'DELETE')}>{t('Revoke app and its connections')}</button>
      </div>)}
    </details>
  </section>
}
