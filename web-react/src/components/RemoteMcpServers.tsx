import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from './Icon'
import './RemoteMcpServers.css'

type RemoteTool = { name: string; title: string; description: string; inputSchema: Record<string, unknown> }
type RemoteServer = {
  id: string; name: string; endpoint: string; hasAuthentication: boolean
  authMode?: 'headers' | 'oauth'; oauthRegistration?: 'auto' | 'manual'; oauthConnected?: boolean
  tools: RemoteTool[]; allowedTools: string[]; connectedAt: string | null; createdAt: string
}
type HeaderRow = { id: string; name: string; value: string }
type RegistryServer = {
  name: string; title: string; description: string; version: string; endpoint: string
  headers: Array<{ name: string; required: boolean; description: string }>
}

export function RemoteMcpServers({ httpBase, orgId, sessionToken }: { httpBase: string; orgId: string; sessionToken: string }) {
  const t = useT()
  const [mode, setMode] = useState<'loading' | 'simple' | 'harness'>('loading')
  const [servers, setServers] = useState<RemoteServer[]>([])
  const [canManage, setCanManage] = useState(false)
  const [expanded, setExpanded] = useState(true)
  const [name, setName] = useState('')
  const [endpoint, setEndpoint] = useState('')
  const [bearer, setBearer] = useState('')
  const [headers, setHeaders] = useState<HeaderRow[]>([])
  const [authMode, setAuthMode] = useState<'headers' | 'oauth'>('headers')
  const [oauthRegistration, setOauthRegistration] = useState<'auto' | 'manual'>('auto')
  const [oauthClientId, setOauthClientId] = useState('')
  const [oauthClientSecret, setOauthClientSecret] = useState('')
  const [catalogQuery, setCatalogQuery] = useState('')
  const [catalog, setCatalog] = useState<{ servers: RegistryServer[]; nextCursor: string | null } | null>(null)
  const [catalogBusy, setCatalogBusy] = useState(false)
  const [catalogError, setCatalogError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const authHeaders = { 'content-type': 'application/json', 'x-session-token': sessionToken }
  const load = useCallback(async () => {
    try {
      const modeRes = await fetch(`${httpBase}/orgs/mode?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      const modeData = await modeRes.json().catch(() => ({}))
      if (!modeRes.ok) throw new Error(modeData.message || t('Could not read workspace mode.'))
      if (modeData.mode !== 'harness') { setMode('simple'); setServers([]); return }
      setMode('harness')
      const res = await fetch(`${httpBase}/remote-mcp?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || t('Could not load Remote MCP servers.'))
      setServers(data.servers || [])
      setCanManage(Boolean(data.canManage))
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }, [httpBase, orgId, sessionToken, t])

  useEffect(() => { void load() }, [load])

  const call = async (path: string, method: string, body?: Record<string, unknown>) => {
    const read = method === 'GET' || method === 'DELETE'
    const url = read ? `${httpBase}${path}${path.includes('?') ? '&' : '?'}orgId=${encodeURIComponent(orgId)}` : `${httpBase}${path}`
    const res = await fetch(url, { method, headers: authHeaders, ...(read ? {} : { body: JSON.stringify({ orgId, ...(body || {}) }) }) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.message || t('That did not work. Try again in a moment.'))
    return data
  }

  const searchCatalog = async (cursor?: string) => {
    const query = catalogQuery.trim()
    if (query.length < 2) { setCatalogError(t('Enter at least 2 characters to search.')); return }
    setCatalogBusy(true); setCatalogError(null)
    try {
      const params = new URLSearchParams({ q: query, ...(cursor ? { cursor } : {}) })
      const result = await call(`/remote-mcp/registry?${params.toString()}`, 'GET') as { servers?: RegistryServer[]; nextCursor?: string | null }
      setCatalog((previous) => ({
        servers: cursor ? [...(previous?.servers || []), ...(result.servers || [])] : (result.servers || []),
        nextCursor: result.nextCursor || null,
      }))
    } catch (err) { setCatalogError(err instanceof Error ? err.message : String(err)) }
    finally { setCatalogBusy(false) }
  }

  const useCatalogServer = (server: RegistryServer) => {
    setName(server.title.slice(0, 80))
    setEndpoint(server.endpoint)
    const required = server.headers.filter((header) => header.required)
    setAuthMode('headers')
    setOauthRegistration('auto'); setOauthClientId(''); setOauthClientSecret(''); setBearer('')
    setHeaders(required.map((header) => ({ id: crypto.randomUUID(), name: header.name, value: '' })))
    setNote(required.length ? t('The listing marks these headers as required. Enter credentials yourself; registry examples are never copied.') : t('The listing does not specify required headers. Review the provider’s authentication and pricing before saving.'))
    setError(null)
  }

  const addServer = async (event: React.FormEvent) => {
    event.preventDefault(); setBusy('add'); setError(null); setNote(null)
    const outgoing = authMode === 'headers' ? [...headers.filter((h) => h.name.trim() && h.value), ...(bearer.trim() ? [{ name: 'Authorization', value: `Bearer ${bearer.trim()}` }] : [])] : []
    try {
      await call('/remote-mcp', 'POST', {
        name, endpoint, authMode, oauthRegistration,
        ...(authMode === 'oauth' && oauthRegistration === 'manual' ? { oauthClientId, oauthClientSecret } : {}),
        headers: outgoing.map(({ name: headerName, value }) => ({ name: headerName, value })),
      })
      setName(''); setEndpoint(''); setBearer(''); setHeaders([]); setAuthMode('headers'); setOauthRegistration('auto'); setOauthClientId(''); setOauthClientSecret('')
      setNote(t('Server saved. Discover its tools to check the connection.'))
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(null) }
  }

  const connectOAuth = async (server: RemoteServer) => {
    setBusy(`${server.id}:oauth`); setError(null); setNote(null)
    try {
      const data = await call(`/remote-mcp/${encodeURIComponent(server.id)}/oauth/start`, 'POST', {})
      if (typeof data.authorizeUrl !== 'string' || !data.authorizeUrl.startsWith('https://')) throw new Error(t('The OAuth server did not return a safe authorization link.'))
      window.location.assign(data.authorizeUrl)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); setBusy(null) }
  }

  const disconnectOAuth = async (server: RemoteServer) => {
    setBusy(`${server.id}:oauth`); setError(null); setNote(null)
    try {
      await call(`/remote-mcp/${encodeURIComponent(server.id)}/oauth/disconnect`, 'POST', {})
      setNote(t('Your OAuth account was disconnected.'))
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(null) }
  }

  const discover = async (id: string) => {
    setBusy(id); setError(null); setNote(null)
    try {
      await call(`/remote-mcp/${encodeURIComponent(id)}/discover`, 'POST', {})
      setNote(t('Tools refreshed. Choose which ones agents may use.'))
      await load()
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(null) }
  }

  const setAllowed = async (server: RemoteServer, toolName: string, enabled: boolean) => {
    setBusy(`${server.id}:${toolName}`); setError(null); setNote(null)
    const allowedTools = enabled ? [...new Set([...server.allowedTools, toolName])] : server.allowedTools.filter((name) => name !== toolName)
    try {
      await call(`/remote-mcp/${encodeURIComponent(server.id)}/tools`, 'PUT', { allowedTools })
      setServers((items) => items.map((item) => item.id === server.id ? { ...item, allowedTools } : item))
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(null) }
  }

  const remove = async (server: RemoteServer) => {
    setBusy(server.id); setError(null); setNote(null)
    try {
      await call(`/remote-mcp/${encodeURIComponent(server.id)}`, 'DELETE')
      setServers((items) => items.filter((item) => item.id !== server.id))
      setNote(t('Remote MCP server disconnected.'))
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(null) }
  }

  if (mode !== 'harness') return null

  return (
    <section className="remote-mcp" aria-labelledby="remote-mcp-title">
      <div className="remote-mcp-head">
        <div className="remote-mcp-heading">
          <span className="remote-mcp-icon"><Icon name="plug" size={17} /></span>
          <div><h2 id="remote-mcp-title">{t('Remote MCP servers')}</h2><p>{t('Connect an MCP server and allow selected tools for workspace agents.')}</p></div>
        </div>
        <button type="button" className="studio-icon-btn" aria-expanded={expanded} aria-label={expanded ? t('Collapse') : t('Expand')} onClick={() => setExpanded((value) => !value)}>
          <Icon name="chevron-down" size={15} className={expanded ? 'remote-mcp-chevron open' : 'remote-mcp-chevron'} />
        </button>
      </div>
      {expanded && <>
        {error && <div className="remote-mcp-message error" role="alert">{error}</div>}
        {note && <div className="remote-mcp-message" role="status">{note}</div>}
        <p className="remote-mcp-security">{t('HTTPS Streamable HTTP only. Credentials are encrypted at rest. Redirects, local IP addresses and private hostnames are blocked. Agents need an API token with Execute access, and only checked tools are exposed.')}</p>
        <div className="remote-mcp-catalog" data-remote-mcp-catalog>
          <div className="remote-mcp-catalog-heading">
            <div><h3>{t('Browse the public MCP catalog')}</h3><p>{t('Search public Streamable HTTP server listings in the MCP Registry and add one to this workspace.')}</p></div>
            <span>{t('Community listings')}</span>
          </div>
          <form className="remote-mcp-catalog-search" onSubmit={(event) => { event.preventDefault(); void searchCatalog() }}>
            <input type="search" value={catalogQuery} onChange={(event) => setCatalogQuery(event.target.value)} placeholder={t('Search MCP servers, e.g. GitHub')} aria-label={t('Search MCP servers')} maxLength={100} />
            <button type="submit" className="studio-btn" disabled={catalogBusy || catalogQuery.trim().length < 2}>{catalogBusy ? t('Searching…') : t('Search catalog')}</button>
          </form>
          <p className="remote-mcp-catalog-disclaimer">{t('Listings are community submitted and are not reviewed by Honmaru. Providers set their own data access, account requirements, pricing and uptime. Search does not connect or send data to a listed provider.')}</p>
          {catalogError && <div className="remote-mcp-message error" role="alert">{catalogError}</div>}
          {catalog && <>
            <div className="remote-mcp-catalog-grid">
              {catalog.servers.map((server) => (
                <article className="remote-mcp-catalog-card" key={server.name} data-registry-server={server.name}>
                  <div className="remote-mcp-catalog-copy">
                    <strong>{server.title}</strong>
                    <small>{server.description || server.name}</small>
                    <span>{server.headers.some((header) => header.required) ? t('Listing marks required headers') : t('Authentication not specified in listing')}</span>
                  </div>
                  <button type="button" className="studio-btn" disabled={!canManage} onClick={() => useCatalogServer(server)}>{canManage ? t('Use server') : t('Admin only')}</button>
                </article>
              ))}
              {catalog.servers.length === 0 && <p className="remote-mcp-empty">{t('No active public HTTPS servers matched this search.')}</p>}
            </div>
            {catalog.nextCursor && <button type="button" className="studio-btn" disabled={catalogBusy} onClick={() => void searchCatalog(catalog.nextCursor || undefined)}>{catalogBusy ? t('Searching…') : t('Load more')}</button>}
          </>}
        </div>
        <div className="remote-mcp-list">
          {servers.map((server) => (
            <article className="remote-mcp-server" key={server.id} data-remote-mcp-server={server.id}>
              <div className="remote-mcp-server-head">
                <div className="remote-mcp-server-title"><strong>{server.name}</strong><span className={(server.authMode === 'oauth' ? server.oauthConnected : server.connectedAt) ? 'connected' : ''}>{server.authMode === 'oauth' ? server.oauthConnected ? t('Your account connected') : t('Sign in required') : server.connectedAt ? t('Connected') : t('Not checked')}</span></div>
                <div className="remote-mcp-actions">
                  {server.authMode === 'oauth' && <>
                    <button type="button" className="studio-btn" disabled={busy === `${server.id}:oauth`} onClick={() => server.oauthConnected ? void disconnectOAuth(server) : void connectOAuth(server)}>
                      <Icon name="plug" size={13} /> {busy === `${server.id}:oauth` ? t('Opening…') : server.oauthConnected ? t('Disconnect my account') : t('Connect my account')}
                    </button>
                  </>}
                  <button type="button" className="studio-btn" disabled={!canManage || busy === server.id} onClick={() => void discover(server.id)}>
                    <Icon name="refresh" size={13} /> {busy === server.id ? t('Checking…') : t('Discover tools')}
                  </button>
                  {canManage && <button type="button" className="remote-mcp-remove" disabled={busy === server.id} onClick={() => void remove(server)}>{t('Disconnect')}</button>}
                </div>
              </div>
              <code className="remote-mcp-endpoint">{server.endpoint}</code>
              <div className="remote-mcp-subline">{server.authMode === 'oauth' ? t('Each member connects their own account · encrypted') : server.hasAuthentication ? t('Authentication saved · encrypted') : t('No authentication header')} · {t('{n} tools available', { n: server.tools.length })}</div>
              {server.tools.length > 0 && <div className="remote-mcp-tools">
                {server.tools.map((tool) => {
                  const key = `${server.id}:${tool.name}`
                  return <label className="remote-mcp-tool" key={tool.name}>
                    <input type="checkbox" checked={server.allowedTools.includes(tool.name)} disabled={!canManage || busy === key} onChange={(event) => void setAllowed(server, tool.name, event.target.checked)} />
                    <span><strong>{tool.title || tool.name}</strong><small>{tool.description || tool.name}</small></span>
                    {busy === key && <i>{t('Saving…')}</i>}
                  </label>
                })}
              </div>}
              {server.tools.length === 0 && <div className="remote-mcp-empty">{t('No tools discovered yet. Add authentication headers if this server requires them, then discover tools.')}</div>}
            </article>
          ))}
          {servers.length === 0 && <div className="remote-mcp-empty">{t('No Remote MCP servers connected yet.')}</div>}
        </div>
        {canManage
          ? <form className="remote-mcp-form" onSubmit={(event) => void addServer(event)}>
              <h3>{t('Add a server')}</h3>
              <label>{t('Display name')}<input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required placeholder={t('e.g. Internal knowledge base')} /></label>
              <label>{t('Server URL')}<input type="url" value={endpoint} onChange={(event) => setEndpoint(event.target.value)} required placeholder="https://mcp.example.com/mcp" /></label>
              <label>{t('Authentication')}<select value={authMode} onChange={(event) => setAuthMode(event.target.value as 'headers' | 'oauth')}>
                <option value="headers">{t('Bearer token or custom headers')}</option><option value="oauth">OAuth 2.1</option>
              </select></label>
              {authMode === 'oauth' ? <>
                <label className="remote-mcp-toggle"><input type="checkbox" checked={oauthRegistration === 'auto'} onChange={(event) => setOauthRegistration(event.target.checked ? 'auto' : 'manual')} />{t('Register OAuth client automatically')}</label>
                {oauthRegistration === 'manual' && <>
                  <label>{t('Client ID')}<input value={oauthClientId} onChange={(event) => setOauthClientId(event.target.value)} maxLength={500} required placeholder={t('OAuth client ID')} /></label>
                  <label>{t('Client secret')}<input type="password" autoComplete="new-password" value={oauthClientSecret} onChange={(event) => setOauthClientSecret(event.target.value)} maxLength={4096} placeholder={t('Optional for public clients')} /></label>
                </>}
                <p className="remote-mcp-form-note">{t('Each member authorizes their own account with PKCE. Tokens are encrypted and never shared between members.')}</p>
                <p className="remote-mcp-form-note">{t('Workflow runs use the workflow creator’s connected account.')}</p>
              </> : <>
                <p className="remote-mcp-form-note">{t('Use the final HTTPS URL without query parameters.')}</p>
                <label>{t('Bearer token')}<input type="password" autoComplete="new-password" value={bearer} onChange={(event) => setBearer(event.target.value)} placeholder={t('Optional · encrypted on save')} /></label>
                <div className="remote-mcp-header-label">{t('Additional headers')}</div>
                {headers.map((header) => <div className="remote-mcp-header-row" key={header.id}>
                  <input value={header.name} onChange={(event) => setHeaders((rows) => rows.map((item) => item.id === header.id ? { ...item, name: event.target.value } : item))} placeholder={t('Header name')} aria-label={t('Header name')} />
                  <input type="password" autoComplete="new-password" value={header.value} onChange={(event) => setHeaders((rows) => rows.map((item) => item.id === header.id ? { ...item, value: event.target.value } : item))} placeholder={t('Header value')} aria-label={t('Header value')} />
                  <button type="button" className="remote-mcp-remove" onClick={() => setHeaders((rows) => rows.filter((item) => item.id !== header.id))}>{t('Remove')}</button>
                </div>)}
                {headers.length < 10 && <button type="button" className="remote-mcp-add-header" onClick={() => setHeaders((rows) => [...rows, { id: crypto.randomUUID(), name: '', value: '' }])}>+ {t('Add header')}</button>}
              </>}
              <button type="submit" className="studio-btn primary remote-mcp-submit" disabled={busy === 'add' || !name.trim() || !endpoint.trim()}>
                <Icon name="plug" size={14} /> {busy === 'add' ? t('Saving…') : t('Save server')}
              </button>
            </form>
          : <p className="remote-mcp-form-note">{t('A workspace admin manages Remote MCP connections.')}</p>}
      </>}
    </section>
  )
}
