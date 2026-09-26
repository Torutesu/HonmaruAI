import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from './Icon'

// Domains & SSO, in the Studio (docs/sso-and-domain-join.md): the company's
// domains proved by DNS, who joins by them, people asking to, and signing in
// through the company's identity provider. Owners change them; admins see
// them and decide on requests.

interface Domain { domain: string; verified: boolean; txtName: string; txtValue: string; joinPolicy: 'off' | 'request' | 'auto'; joinRole: 'member' | 'guest'; joinChannels: string[] }
interface Sso {
  provider: string; issuer: string; clientId: string; clientSecret: string | null; allowedDomains: string[]
  hostedDomain: string | null; tenantId: string | null; enforce: boolean; sessionHours: number | null
  status: 'draft' | 'testing' | 'active' | 'disabled'; testedAt: string | null; test: { email: string; subject: string; name: string | null } | null
}
interface Provider { id: string; name: string; issuer: string | null }

export const DomainsSso: React.FC<{ httpBase: string; orgId: string; sessionToken: string }> = ({ httpBase, orgId, sessionToken }) => {
  const t = useT()
  const [domains, setDomains] = useState<Domain[] | null>(null)
  const [canEdit, setCanEdit] = useState(false)
  const [adding, setAdding] = useState('')
  const [requests, setRequests] = useState<Array<{ ref: string; name: string; requestedAt: string }>>([])
  const [sso, setSso] = useState<Sso | null>(null)
  const [providers, setProviders] = useState<Provider[]>([])
  const [callback, setCallback] = useState('')
  const [ready, setReady] = useState(true)
  const [form, setForm] = useState({ provider: 'google', issuer: 'https://accounts.google.com', clientId: '', clientSecret: '', allowedDomains: [] as string[], hostedDomain: '', tenantId: '', sessionHours: '24' })
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const headers = { 'x-session-token': sessionToken, 'content-type': 'application/json' }
  const q = `orgId=${encodeURIComponent(orgId)}`

  const load = useCallback(async () => {
    const [d, s, r] = await Promise.all([
      fetch(`${httpBase}/orgs/domains?${q}`, { headers: { 'x-session-token': sessionToken } }),
      fetch(`${httpBase}/orgs/sso?${q}`, { headers: { 'x-session-token': sessionToken } }),
      fetch(`${httpBase}/orgs/join-requests?${q}`, { headers: { 'x-session-token': sessionToken } }),
    ])
    if (d.ok) { const data = await d.json(); setDomains(data.domains || []); setCanEdit(data.canEdit === true) } else setDomains([])
    if (s.ok) {
      const data = await s.json()
      setProviders(data.providers || []); setCallback(data.callback || ''); setReady(data.ready !== false)
      setSso(data.sso)
      if (data.sso) setForm({ provider: data.sso.provider, issuer: data.sso.issuer, clientId: data.sso.clientId, clientSecret: '', allowedDomains: data.sso.allowedDomains, hostedDomain: data.sso.hostedDomain || '', tenantId: data.sso.tenantId || '', sessionHours: String(data.sso.sessionHours || 24) })
    }
    if (r.ok) setRequests((await r.json()).requests || [])
  }, [httpBase, orgId, sessionToken])
  useEffect(() => { void load() }, [load])
  useEffect(() => { if (location.hash.includes('tested=1')) setNote(t('The test sign-in worked. You can turn single sign-on on.')) }, [])

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

      <div className="studio-section-head"><div><h2>{t('Single sign-on')}</h2><p>{t('Google Workspace, Okta, Microsoft Entra ID, or any OpenID Connect provider.')}</p></div></div>
      {!ready && <p className="form-note">{t('Single sign-on is not set up on this deployment yet.')}</p>}
      {sso && (
        <p className="row-sub" data-sso-status={sso.status}>
          {sso.status === 'active' ? t('On') : sso.status === 'disabled' ? t('Off') : t('Not on yet')}
          {sso.enforce ? ` · ${t('Required for people at your domains')}` : ''}
          {sso.test ? ` · ${t('Last test: {email}', { email: sso.test.email })}` : ''}
        </p>
      )}
      {callback && <p className="row-sub">{t('Redirect URI to give your provider:')} <code>{callback}</code></p>}
      <form className="org-key-form" onSubmit={(e) => { e.preventDefault(); void send('/orgs/sso', 'PUT', { ...form, sessionHours: Number(form.sessionHours) }, t('Saved. Test it before turning it on.')) }}>
        <select className="rules-number wide" value={form.provider} disabled={!canEdit} onChange={(e) => {
          const p = providers.find((x) => x.id === e.target.value)
          setForm({ ...form, provider: e.target.value, issuer: p?.issuer || '' })
        }}>
          {providers.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <input className="rules-number wide" placeholder={t('Issuer, like https://your-company.okta.com')} value={form.issuer} disabled={!canEdit} onChange={(e) => setForm({ ...form, issuer: e.target.value })} />
        <input className="rules-number wide" placeholder={t('Client ID')} value={form.clientId} disabled={!canEdit} onChange={(e) => setForm({ ...form, clientId: e.target.value })} />
        <input className="rules-number wide" type="password" placeholder={sso?.clientSecret ? t('Client secret (saved; type to replace)') : t('Client secret')} value={form.clientSecret} disabled={!canEdit} onChange={(e) => setForm({ ...form, clientSecret: e.target.value })} autoComplete="off" />
        {form.provider === 'google' && <input className="rules-number wide" placeholder={t('Workspace domain (hd), like your-company.com')} value={form.hostedDomain} disabled={!canEdit} onChange={(e) => setForm({ ...form, hostedDomain: e.target.value })} />}
        {form.provider === 'entra' && <input className="rules-number wide" placeholder={t('Tenant ID')} value={form.tenantId} disabled={!canEdit} onChange={(e) => setForm({ ...form, tenantId: e.target.value })} />}
        <div className="org-key-scopes">
          <span className="row-sub">{t('Domains that sign in this way')}</span>
          {verified.length === 0 && <span className="row-sub">{t('Verify a domain first.')}</span>}
          {verified.map((d) => (
            <label key={d} className="dlg-check"><input type="checkbox" disabled={!canEdit} checked={form.allowedDomains.includes(d)}
              onChange={() => setForm({ ...form, allowedDomains: form.allowedDomains.includes(d) ? form.allowedDomains.filter((x) => x !== d) : [...form.allowedDomains, d] })} /> {d}</label>
          ))}
        </div>
        <label className="rules-input">{t('An SSO sign-in lasts')} <input className="rules-number" type="number" min={1} max={720} value={form.sessionHours} disabled={!canEdit} onChange={(e) => setForm({ ...form, sessionHours: e.target.value })} /> <span className="rules-unit">{t('hours')}</span></label>
        {canEdit && (
          <div className="rules-actions">
            <button type="submit" className="studio-btn primary" disabled={busy || !ready}>{t('Save')}</button>
            {sso && <button type="button" className="studio-btn" disabled={busy} data-sso-test onClick={() => void send('/orgs/sso/test', 'POST', {}).then((d) => { if (d?.url) window.open(d.url, '_self') })}>{t('Test sign-in')}</button>}
            {sso && sso.status !== 'active' && <button type="button" className="studio-btn" disabled={busy || !sso.testedAt} onClick={() => void send('/orgs/sso/activate', 'POST', {}, t('Single sign-on is on.'))}>{t('Turn on')}</button>}
            {sso?.status === 'active' && (
              <button type="button" className="studio-btn" disabled={busy} onClick={() => void send('/orgs/sso/enforce', 'PUT', { enforce: !sso.enforce }, sso.enforce ? t('No longer required.') : t('Required now.'))}>
                {sso.enforce ? t('Stop requiring it') : t('Require it')}
              </button>
            )}
            {sso && sso.status !== 'disabled' && <button type="button" className="studio-btn danger" disabled={busy} onClick={() => void send('/orgs/sso', 'DELETE', {}, t('Single sign-on is off.'))}>{t('Turn off')}</button>}
          </div>
        )}
        {!canEdit && <p className="form-note">{t('An owner of this workspace can change these.')}</p>}
        {sso?.status === 'active' && !sso.enforce && canEdit && <p className="row-sub">{t('Requiring it signs out everyone at your domains who did not sign in this way. Keep one owner with an address outside them, so someone can get in if the provider is down.')}</p>}
      </form>
    </section>
  )
}
