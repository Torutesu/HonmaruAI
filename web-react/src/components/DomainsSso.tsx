import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from './Icon'

// Domains & SSO, in the Studio (docs/sso-and-domain-join.md): the company's
// domains proved by DNS, who joins by them, people asking to, and signing in
// through the company's identity provider. Owners change them; admins see
// them and decide on requests.

interface Domain { domain: string; verified: boolean; txtName: string; txtValue: string; joinPolicy: 'off' | 'request' | 'auto'; joinRole: 'member' | 'guest'; joinChannels: string[] }
interface Connection {
  id: string; name: string; provider: string; issuer: string; clientId: string | null; clientSecret: string | null
  ssoUrl: string | null; certificate: string | null; allowedDomains: string[]; hostedDomain: string | null; tenantId: string | null
  sessionHours: number | null; status: 'draft' | 'testing' | 'active' | 'disabled'; testedAt: string | null
  test: { email: string; subject: string; name: string | null } | null
  sp?: { entityId: string; acs: string; metadata: string }
}
interface Provider { id: string; name: string; issuer: string | null }

export const DomainsSso: React.FC<{ httpBase: string; orgId: string; sessionToken: string }> = ({ httpBase, orgId, sessionToken }) => {
  const t = useT()
  const [domains, setDomains] = useState<Domain[] | null>(null)
  const [canEdit, setCanEdit] = useState(false)
  const [adding, setAdding] = useState('')
  const [requests, setRequests] = useState<Array<{ ref: string; name: string; requestedAt: string }>>([])
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const headers = { 'x-session-token': sessionToken, 'content-type': 'application/json' }
  const q = `orgId=${encodeURIComponent(orgId)}`

  const load = useCallback(async () => {
    const [d, r] = await Promise.all([
      fetch(`${httpBase}/orgs/domains?${q}`, { headers: { 'x-session-token': sessionToken } }),
      fetch(`${httpBase}/orgs/join-requests?${q}`, { headers: { 'x-session-token': sessionToken } }),
    ])
    if (d.ok) { const data = await d.json(); setDomains(data.domains || []); setCanEdit(data.canEdit === true) } else setDomains([])
    if (r.ok) setRequests((await r.json()).requests || [])
  }, [httpBase, orgId, sessionToken])
  useEffect(() => { void load() }, [load])

  const send = async (path: string, method: string, body: Record<string, unknown>, done?: string) => {
    setBusy(true); setError(null); setNote(null)
    try {
      const res = await fetch(`${httpBase}${path}`, { method, headers, body: JSON.stringify({ orgId, ...body }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not work.')); return null }
      if (done) setNote(done)
      await load()
      return data
    } finally { setBusy(false) }
  }
  const verified = (domains || []).filter((d) => d.verified).map((d) => d.domain)

  return (
    <section className="studio-page sso-page" data-studio-page="sso">
      <h1 className="studio-title">{t('Domains & SSO')}</h1>
      <p className="studio-lede">{t('Prove your company owns its domain, let people at it join, and have them sign in with your identity provider.')}</p>
      {note && <p className="rules-note" role="status">{note}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      <div className="studio-section-head"><div><h2>{t('Domains')}</h2><p>{t('Add a TXT record to your DNS to prove a domain is yours.')}</p></div></div>
      {(domains || []).map((d) => (
        <div key={d.domain} className="sso-domain" data-domain={d.domain}>
          <div className="sso-domain-head">
            <b>{d.domain}</b>
            <span className={`sso-badge${d.verified ? ' ok' : ''}`}>{d.verified ? t('Verified') : t('Not verified')}</span>
          </div>
          {!d.verified && (
            <>
              <p className="row-sub">{t('Add this TXT record to {domain}, then verify.', { domain: d.txtName })}</p>
              <div className="dlg-secret"><code data-txt-value>{d.txtValue}</code>
                <button type="button" className="studio-btn" onClick={() => navigator.clipboard?.writeText(d.txtValue)}><Icon name="copy" size={13} /> {t('Copy')}</button>
                {canEdit && <button type="button" className="studio-btn primary" disabled={busy} onClick={() => void send('/orgs/domains/verify', 'POST', { domain: d.domain }, t('{domain} is verified.', { domain: d.domain }))}>{t('Verify')}</button>}
              </div>
            </>
          )}
          {d.verified && (
            <div className="sso-domain-policy">
              <label>{t('People at this domain')}{' '}
                <select value={d.joinPolicy} disabled={!canEdit || busy} data-join-policy={d.domain}
                  onChange={(e) => void send('/orgs/domains', 'PUT', { domain: d.domain, joinPolicy: e.target.value }, t('Saved.'))}>
                  <option value="off">{t('join only by invitation')}</option>
                  <option value="request">{t('can ask to join')}</option>
                  <option value="auto">{t('join when they sign in')}</option>
                </select>
              </label>
            </div>
          )}
          {canEdit && <button type="button" className="studio-btn danger" onClick={() => void send('/orgs/domains', 'DELETE', { domain: d.domain })}>{t('Remove')}</button>}
        </div>
      ))}
      {canEdit && (
        <form className="rules-actions" onSubmit={(e) => { e.preventDefault(); void send('/orgs/domains', 'POST', { domain: adding }).then((ok) => { if (ok) setAdding('') }) }}>
          <input className="rules-number wide" placeholder={t('your-company.com')} value={adding} onChange={(e) => setAdding(e.target.value)} data-add-domain />
          <button type="submit" className="studio-btn primary" disabled={!adding.trim() || busy}>{t('Add domain')}</button>
        </form>
      )}

      {requests.length > 0 && (
        <>
          <div className="studio-section-head"><div><h2>{t('Asking to join')}</h2></div></div>
          {requests.map((r) => (
            <div key={r.ref} className="sso-domain" data-join-request={r.ref}>
              <b>{r.name}</b>
              <div className="rules-actions">
                <button type="button" className="studio-btn primary" onClick={() => void send('/orgs/join-requests', 'POST', { ref: r.ref, approve: true })}>{t('Let them in')}</button>
                <button type="button" className="studio-btn" onClick={() => void send('/orgs/join-requests', 'POST', { ref: r.ref, approve: false })}>{t('Decline')}</button>
              </div>
            </div>
          ))}
        </>
      )}

      <SsoConnections httpBase={httpBase} orgId={orgId} sessionToken={sessionToken} verified={verified} />

      <div className="studio-section-head"><div><h2>{t('Provisioning (SCIM)')}</h2><p>{t('Let your identity provider add people, stop them, and keep groups in step. Make a workspace key with the scim:write scope under API & Webhooks, and give the provider this address and that key.')}</p></div></div>
      <div className="sso-domain" data-scim-base>
        <code>{`${httpBase}/scim/v2`}</code>
        <p className="row-sub">{t('Only addresses at your verified domains are taken. Someone the provider stops leaves the workspace and is signed out everywhere at once. An owner is never stopped this way.')}</p>
      </div>
    </section>
  )
}

/// The workspace's identity providers: one per company or subsidiary, each
/// for its own domains — OpenID Connect or SAML 2.0 — and whether signing in
/// through them is required.
const SsoConnections: React.FC<{ httpBase: string; orgId: string; sessionToken: string; verified: string[] }> = ({ httpBase, orgId, sessionToken, verified }) => {
  const t = useT()
  const blank = { provider: 'google', name: '', issuer: 'https://accounts.google.com', clientId: '', clientSecret: '', hostedDomain: '', tenantId: '', ssoUrl: '', certificate: '', metadataXml: '', allowedDomains: [] as string[], sessionHours: '24' }
  const [connections, setConnections] = useState<Connection[]>([])
  const [enforce, setEnforce] = useState(false)
  const [canEdit, setCanEdit] = useState(false)
  const [providers, setProviders] = useState<Provider[]>([])
  const [callback, setCallback] = useState('')
  const [ready, setReady] = useState(true)
  const [editing, setEditing] = useState<string | null>(null)
  const [form, setForm] = useState(blank)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const headers = { 'x-session-token': sessionToken, 'content-type': 'application/json' }

  const load = useCallback(async () => {
    const res = await fetch(`${httpBase}/orgs/sso?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } }).catch(() => null)
    if (!res?.ok) return
    const data = await res.json()
    setConnections(data.connections || []); setEnforce(Boolean(data.enforce)); setCanEdit(data.canEdit === true)
    setProviders(data.providers || []); setCallback(data.callback || ''); setReady(data.ready !== false)
  }, [httpBase, orgId, sessionToken])
  useEffect(() => { void load() }, [load])
  useEffect(() => { if (location.hash.includes('tested=1')) setNote(t('The test sign-in worked. You can turn this connection on.')) }, [])

  const send = async (path: string, method: string, body: Record<string, unknown>, done?: string) => {
    setBusy(true); setError(null); setNote(null)
    try {
      const url = `${httpBase}${path}${method === 'DELETE' ? `?orgId=${encodeURIComponent(orgId)}` : ''}`
      const res = await fetch(url, { method, headers, ...(method === 'DELETE' ? {} : { body: JSON.stringify({ orgId, ...body }) }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not work.')); return null }
      if (done) setNote(done)
      await load()
      return data
    } finally { setBusy(false) }
  }
  const edit = (c: Connection | null) => {
    setError(null); setNote(null)
    if (!c) { setEditing('new'); setForm(blank); return }
    setEditing(c.id)
    setForm({ ...blank, provider: c.provider, name: c.name, issuer: c.issuer, clientId: c.clientId || '', hostedDomain: c.hostedDomain || '', tenantId: c.tenantId || '', ssoUrl: c.ssoUrl || '', allowedDomains: c.allowedDomains, sessionHours: String(c.sessionHours || 24) })
  }
  const save = async () => {
    const saml = form.provider === 'saml'
    const body: Record<string, unknown> = {
      provider: form.provider, name: form.name, allowedDomains: form.allowedDomains, sessionHours: Number(form.sessionHours),
      ...(saml
        ? { ...(form.metadataXml.trim() ? { metadataXml: form.metadataXml } : { issuer: form.issuer, ssoUrl: form.ssoUrl }), ...(form.certificate.trim() ? { certificate: form.certificate } : {}) }
        : { issuer: form.issuer, clientId: form.clientId, ...(form.clientSecret ? { clientSecret: form.clientSecret } : {}), hostedDomain: form.hostedDomain || null, tenantId: form.tenantId || null }),
    }
    const out = editing && editing !== 'new'
      ? await send(`/orgs/sso/connections/${encodeURIComponent(editing)}`, 'PUT', body, t('Saved. Test it before turning it on.'))
      : await send('/orgs/sso/connections', 'POST', body, t('Saved. Test it before turning it on.'))
    if (out) setEditing(null)
  }
  const current = connections.find((c) => c.id === editing) || null
  const takenElsewhere = new Set(connections.filter((c) => c.id !== editing && c.status !== 'disabled').flatMap((c) => c.allowedDomains))
  const anyOn = connections.some((c) => c.status === 'active')
  const copy = (text: string) => { void navigator.clipboard?.writeText(text) }

  return (
    <>
      <div className="studio-section-head"><div><h2>{t('Single sign-on')}</h2><p>{t('Google Workspace, Okta, Microsoft Entra ID, any OpenID Connect provider, or SAML 2.0. Connect one per company or subsidiary; each covers its own domains.')}</p></div>
        {canEdit && editing === null && <button type="button" className="studio-btn primary" disabled={!ready} onClick={() => edit(null)} data-sso-add>{t('Add a connection')}</button>}
      </div>
      {!ready && <p className="form-note">{t('Single sign-on is not set up on this deployment yet.')}</p>}
      {note && <p className="rules-note" role="status">{note}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      {connections.map((c) => (
        <div key={c.id} className="sso-domain" data-sso-connection={c.id} data-sso-status={c.status}>
          <div className="sso-domain-head">
            <b>{c.name}</b>
            <span className={`sso-badge${c.status === 'active' ? ' ok' : ''}`}>{c.status === 'active' ? t('On') : c.status === 'disabled' ? t('Off') : t('Not on yet')}</span>
          </div>
          <p className="row-sub">{providers.find((p) => p.id === c.provider)?.name || c.provider} · {c.allowedDomains.join(', ')}{c.test ? ` · ${t('Last test: {email}', { email: c.test.email })}` : ''}</p>
          {c.sp && (
            <div className="sso-sp">
              <p className="row-sub">{t('Give your identity provider these:')}</p>
              {[[t('Entity ID'), c.sp.entityId], [t('Reply URL (ACS)'), c.sp.acs], [t('Metadata'), c.sp.metadata]].map(([label, value]) => (
                <div key={label} className="dlg-secret"><span className="row-sub">{label}</span> <code>{value}</code>
                  <button type="button" className="studio-btn" onClick={() => copy(value)}>{t('Copy')}</button></div>
              ))}
            </div>
          )}
          {canEdit && editing === null && (
            <div className="rules-actions">
              <button type="button" className="studio-btn" disabled={busy} onClick={() => edit(c)}>{t('Edit')}</button>
              {c.status !== 'disabled' && <button type="button" className="studio-btn" disabled={busy} data-sso-test onClick={() => void send(`/orgs/sso/connections/${encodeURIComponent(c.id)}/test`, 'POST', {}).then((d) => { if (d?.url) window.open(d.url, '_self') })}>{t('Test sign-in')}</button>}
              {c.status !== 'active' && <button type="button" className="studio-btn" disabled={busy || !c.testedAt} onClick={() => void send(`/orgs/sso/connections/${encodeURIComponent(c.id)}/activate`, 'POST', {}, t('Single sign-on is on.'))}>{t('Turn on')}</button>}
              {c.status !== 'disabled' && <button type="button" className="studio-btn danger" disabled={busy} onClick={() => void send(`/orgs/sso/connections/${encodeURIComponent(c.id)}`, 'DELETE', {}, t('Single sign-on is off.'))}>{t('Turn off')}</button>}
            </div>
          )}
        </div>
      ))}

      {editing !== null && canEdit && (
        <form className="org-key-form" data-sso-form onSubmit={(e) => { e.preventDefault(); void save() }}>
          <select className="rules-number wide" value={form.provider} disabled={Boolean(current)} onChange={(e) => {
            const p = providers.find((x) => x.id === e.target.value)
            setForm({ ...form, provider: e.target.value, issuer: p?.issuer || '' })
          }} data-sso-provider>
            {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
          <input className="rules-number wide" placeholder={t('Name, like Acme Okta')} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} data-sso-name />
          {form.provider === 'saml' ? (
            <>
              <textarea className="rules-number wide" rows={4} placeholder={t('Paste the metadata XML from your identity provider (or fill in the three fields below)')} value={form.metadataXml} onChange={(e) => setForm({ ...form, metadataXml: e.target.value })} data-sso-metadata />
              <input className="rules-number wide" placeholder={t('Identity provider entity ID')} value={form.issuer} disabled={Boolean(form.metadataXml.trim())} onChange={(e) => setForm({ ...form, issuer: e.target.value })} />
              <input className="rules-number wide" placeholder={t('Sign-in address (HTTP-Redirect), https://…')} value={form.ssoUrl} disabled={Boolean(form.metadataXml.trim())} onChange={(e) => setForm({ ...form, ssoUrl: e.target.value })} />
              <textarea className="rules-number wide" rows={3} placeholder={current?.certificate ? t('Signing certificate (saved; paste to replace)') : t('Signing certificate (PEM)')} value={form.certificate} disabled={Boolean(form.metadataXml.trim())} onChange={(e) => setForm({ ...form, certificate: e.target.value })} />
            </>
          ) : (
            <>
              {callback && <p className="row-sub">{t('Redirect URI to give your provider:')} <code>{callback}</code></p>}
              <input className="rules-number wide" placeholder={t('Issuer, like https://your-company.okta.com')} value={form.issuer} onChange={(e) => setForm({ ...form, issuer: e.target.value })} />
              <input className="rules-number wide" placeholder={t('Client ID')} value={form.clientId} onChange={(e) => setForm({ ...form, clientId: e.target.value })} />
              <input className="rules-number wide" type="password" placeholder={current?.clientSecret ? t('Client secret (saved; type to replace)') : t('Client secret')} value={form.clientSecret} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} autoComplete="off" />
              {form.provider === 'google' && <input className="rules-number wide" placeholder={t('Workspace domain (hd), like your-company.com')} value={form.hostedDomain} onChange={(e) => setForm({ ...form, hostedDomain: e.target.value })} />}
              {form.provider === 'entra' && <input className="rules-number wide" placeholder={t('Tenant ID')} value={form.tenantId} onChange={(e) => setForm({ ...form, tenantId: e.target.value })} />}
            </>
          )}
          <div className="org-key-scopes">
            <span className="row-sub">{t('Domains that sign in this way')}</span>
            {verified.length === 0 && <span className="row-sub">{t('Verify a domain first.')}</span>}
            {verified.map((d) => (
              <label key={d} className="dlg-check"><input type="checkbox" disabled={takenElsewhere.has(d)} checked={form.allowedDomains.includes(d)}
                onChange={() => setForm({ ...form, allowedDomains: form.allowedDomains.includes(d) ? form.allowedDomains.filter((x) => x !== d) : [...form.allowedDomains, d] })} /> {d}{takenElsewhere.has(d) ? ` (${t('another connection')})` : ''}</label>
            ))}
          </div>
          <label className="rules-input">{t('An SSO sign-in lasts')} <input className="rules-number" type="number" min={1} max={720} value={form.sessionHours} onChange={(e) => setForm({ ...form, sessionHours: e.target.value })} /> <span className="rules-unit">{t('hours')}</span></label>
          <div className="rules-actions">
            <button type="submit" className="studio-btn primary" disabled={busy || !form.allowedDomains.length}>{t('Save')}</button>
            <button type="button" className="studio-btn" onClick={() => setEditing(null)}>{t('Cancel')}</button>
          </div>
        </form>
      )}

      {anyOn && canEdit && editing === null && (
        <div className="rules-actions">
          <button type="button" className="studio-btn" disabled={busy} onClick={() => void send('/orgs/sso/enforce', 'PUT', { enforce: !enforce }, enforce ? t('No longer required.') : t('Required now.'))} data-sso-enforce>
            {enforce ? t('Stop requiring it') : t('Require it')}
          </button>
          <span className="row-sub">{enforce ? t('Required for people at your domains') : t('Requiring it signs out everyone at your domains who did not sign in this way. Keep one owner with an address outside them, so someone can get in if the provider is down.')}</span>
        </div>
      )}
      {!canEdit && <p className="form-note">{t('An owner of this workspace can change these.')}</p>}
    </>
  )
}
