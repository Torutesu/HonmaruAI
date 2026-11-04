import React, { useEffect, useRef, useState } from 'react'

import { clearMcpRequest } from '../utils/mcpConsentRequest'
import './McpConnections.css'

type Permission = { name: string; title: string; description: string }
type Consent = { clientName: string; clientId: string; redirectOrigin: string; scopes: Permission[]; workspaces: { id: string; name: string | null; founder: string | null }[] }
export function McpConsent({ httpBase, sessionToken, requestId, onExit }: { httpBase: string; sessionToken: string; requestId: string; onExit: () => void }) {
  const [consent, setConsent] = useState<Consent | null>(null)
  const [workspace, setWorkspace] = useState('')
  const [selected, setSelected] = useState<string[]>([])
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const generation = useRef(0)
  useEffect(() => {
    ++generation.current
    const controller = new AbortController()
    setConsent(null); setSelected([]); setWorkspace(''); setError('')
    void fetch(`${httpBase}/mcp/oauth/requests/${encodeURIComponent(requestId)}`, { headers: { 'x-session-token': sessionToken }, signal: controller.signal })
      .then(async response => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error_description || data.message || 'Could not load this connection request.')
        if (controller.signal.aborted) return
        setConsent(data); setWorkspace(data.workspaces[0]?.id || '')
        setSelected(data.scopes.filter((scope: Permission) => scope.name === 'chat:read').map((scope: Permission) => scope.name))
      }).catch(error => { if (!controller.signal.aborted) setError(error.message) })
    return () => { ++generation.current; controller.abort() }
  }, [httpBase, sessionToken, requestId])
  const answer = async (approve: boolean) => {
    const current = generation.current
    setBusy(true); setError('')
    try {
      const response = await fetch(`${httpBase}/mcp/oauth/requests/${encodeURIComponent(requestId)}`, { method: 'POST', headers: { 'x-session-token': sessionToken, 'content-type': 'application/json' }, body: JSON.stringify({ approve, orgId: workspace, scopes: selected }) })
      const data = await response.json()
      if (current !== generation.current) return
      if (!response.ok) throw new Error(data.error_description || data.message || 'Could not authorize this connection.')
      const redirect = new URL(data.redirectUrl)
      if (!consent || redirect.origin !== consent.redirectOrigin || !['https:', 'http:'].includes(redirect.protocol)) throw new Error('The callback address changed. Restart from your app.')
      clearMcpRequest(sessionStorage)
      window.location.assign(redirect.href)
    } catch (error) { if (current === generation.current) { setError(error instanceof Error ? error.message : 'Could not authorize this connection.'); setBusy(false) } }
  }
  return <main className="screen"><div className="screen-body mcp-consent">
    <h1>Connect {consent?.clientName || 'an AI app'} to Honmaru</h1>
    <p>This app will act as you. Allow only the permissions you want it to use. You can disconnect it under Studio, API &amp; Webhooks.</p>
    {error && <p role="alert">{error}</p>}
    {!consent && !error && <p role="status">Loading connection request…</p>}
    {consent && <>
      <p>Callback address <code>{consent.redirectOrigin}</code></p>
      <p>Client ID <code>{consent.clientId}</code></p>
      <p>App names are supplied by their developer. Check that you recognize the app and callback address.</p>
      <label>Workspace<select value={workspace} onChange={event => setWorkspace(event.target.value)} disabled={busy}>
        {consent.workspaces.map(org => <option key={org.id} value={org.id}>{org.name || org.founder || org.id}</option>)}
      </select></label>
      <fieldset disabled={busy}><legend>Permissions requested</legend>
        {consent.scopes.map(scope => <label key={scope.name}>
          <input type="checkbox" checked={selected.includes(scope.name)} onChange={event => setSelected(values => event.target.checked ? [...values, scope.name] : values.filter(value => value !== scope.name))} /> {scope.title}
          <span>{scope.description}</span>
        </label>)}
      </fieldset>
      {!consent.workspaces.length && <p>You need a workspace membership to connect an app.</p>}
      <button className="btn btn-primary" disabled={busy || !workspace || !selected.length} onClick={() => void answer(true)}>Allow selected permissions</button>
      <button className="btn" disabled={busy} onClick={() => void answer(false)}>Deny</button>
    </>}
    <button className="btn" disabled={busy} onClick={onExit}>Back to Honmaru</button>
  </div></main>
}
