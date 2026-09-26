import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from './Icon'

// A workspace's own keys (docs/admin-controls.md §2), under API & Webhooks:
// for an HR system or Terraform, owned by the workspace rather than by
// whoever made them. Owners make and revoke them; admins see them.

interface OrgKey {
  id: string; prefix: string; name: string; scopes: string[]; allowedIps: string[] | null
  expiresAt: string | null; createdBy: string | null; createdAt: string; lastUsedAt: string | null; lastUsedIp: string | null; revoked: boolean
}
const SCOPE_WORD: Record<string, string> = {
  'members:read': 'Read people', 'members:write': 'Add, change and remove people',
  'channels:read': 'Read channels', 'channels:write': 'Make and change channels',
  'audit:read': 'Read the audit log', 'scim:write': 'SCIM provisioning',
}

export const WorkspaceKeys: React.FC<{ httpBase: string; orgId: string; sessionToken: string }> = ({ httpBase, orgId, sessionToken }) => {
  const t = useT()
  const [keys, setKeys] = useState<OrgKey[] | null>(null)
  const [canEdit, setCanEdit] = useState(false)
  const [scopes, setScopes] = useState<string[]>([])
  const [making, setMaking] = useState(false)
  const [name, setName] = useState('')
  const [chosen, setChosen] = useState<string[]>(['members:read'])
  const [ips, setIps] = useState('')
  const [days, setDays] = useState('90')
  const [never, setNever] = useState(false)
  const [reason, setReason] = useState('')
  const [minted, setMinted] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const headers = { 'x-session-token': sessionToken, 'content-type': 'application/json' }

  const load = useCallback(async () => {
    const res = await fetch(`${httpBase}/orgs/keys?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
    if (!res.ok) { setKeys(null); return }
    const data = await res.json()
    setKeys(data.keys || []); setCanEdit(data.canEdit === true); setScopes(data.scopes || [])
  }, [httpBase, orgId, sessionToken])
  useEffect(() => { void load() }, [load])

  const create = async () => {
    setBusy(true); setError(null)
    try {
      const body = {
        orgId, name, scopes: chosen,
        allowedIps: ips.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean),
        ...(never ? { neverExpires: true, reason } : { expiresInDays: Number(days) }),
      }
      const res = await fetch(`${httpBase}/orgs/keys`, { method: 'POST', headers, body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not work.')); return }
      setMinted(data.key); setMaking(false); setName(''); setIps('')
      await load()
    } finally { setBusy(false) }
  }
  const revoke = async (id: string) => {
    const res = await fetch(`${httpBase}/orgs/keys/${encodeURIComponent(id)}?orgId=${encodeURIComponent(orgId)}`, { method: 'DELETE', headers })
    if (res.ok) await load()
  }

  if (keys === null) return null
  const when = (iso: string | null) => iso ? new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' }) : '—'
  return (
    <div className="workspace-keys" data-workspace-keys>
      <div className="studio-section-head">
        <div>
          <h2>{t('Workspace keys')}</h2>
          <p>{t('For an HR system or Terraform: add and remove people, set up channels, read the audit log. The key belongs to the workspace, not to whoever made it, and never reads messages.')}</p>
        </div>
        {canEdit && !making && <button type="button" className="studio-btn primary" data-make-org-key onClick={() => { setMaking(true); setMinted(null); setError(null) }}><Icon name="plus" size={14} /> {t('Make a key')}</button>}
      </div>
      <p className="row-sub"><a href={`${httpBase}/admin/v1/openapi.json`} target="_blank" rel="noreferrer">{t('The admin API, described (OpenAPI)')}</a></p>
      {!canEdit && <p className="form-note">{t('An owner of this workspace can make these.')}</p>}
      {minted && (
        <div className="dlg-secret" role="status" data-org-key-minted>
          <code>{minted}</code>
          <button type="button" className="studio-btn" onClick={() => navigator.clipboard?.writeText(minted)}><Icon name="copy" size={13} /> {t('Copy')}</button>
          <span className="row-sub">{t('Copy it now: it is not shown again.')}</span>
        </div>
      )}
      {making && (
        <form className="org-key-form" onSubmit={(e) => { e.preventDefault(); void create() }}>
          <input className="rules-number wide" placeholder={t('Name, like "Workday sync"')} value={name} onChange={(e) => setName(e.target.value)} data-org-key-name />
          <div className="org-key-scopes">
            {scopes.map((s) => (
              <label key={s} className="dlg-check">
                <input type="checkbox" checked={chosen.includes(s)} onChange={() => setChosen(chosen.includes(s) ? chosen.filter((x) => x !== s) : [...chosen, s])} />
                {t(SCOPE_WORD[s] || s)} <code>{s}</code>
              </label>
            ))}
          </div>
          <input className="rules-number wide" placeholder={t('Only from these addresses (optional), e.g. 203.0.113.0/24')} value={ips} onChange={(e) => setIps(e.target.value)} />
          <div className="org-key-expiry">
            <label className="dlg-check"><input type="checkbox" checked={never} onChange={(e) => setNever(e.target.checked)} /> {t('Never expires')}</label>
            {never
              ? <input className="rules-number wide" placeholder={t('Why this key should never expire')} value={reason} onChange={(e) => setReason(e.target.value)} />
              : <label className="rules-input"><input className="rules-number" type="number" min={1} max={730} value={days} onChange={(e) => setDays(e.target.value)} /> <span className="rules-unit">{t('days')}</span></label>}
          </div>
          {error && <p className="form-error" role="alert">{error}</p>}
          <div className="rules-actions">
            <button type="submit" className="studio-btn primary" disabled={busy || !name.trim() || !chosen.length || (never && !reason.trim())}>{t('Make the key')}</button>
            <button type="button" className="studio-btn" onClick={() => setMaking(false)}>{t('Cancel')}</button>
          </div>
        </form>
      )}
      {keys.length > 0 && (
        <div className="studio-table" role="table" aria-label={t('Workspace keys')}>
          <div className="studio-tr head" role="row">
            <span role="columnheader">{t('Name')}</span><span role="columnheader">{t('Permissions')}</span>
            <span role="columnheader">{t('Expires')}</span><span role="columnheader">{t('Last used')}</span><span />
          </div>
          {keys.map((k) => (
            <div className="studio-tr" role="row" key={k.id} data-org-key={k.id}>
              <span role="cell"><b>{k.name}</b><br /><code className="row-sub">{k.prefix}…</code></span>
              <span role="cell" className="row-sub">{k.scopes.join(', ')}{k.allowedIps ? ` · ${k.allowedIps.join(', ')}` : ''}</span>
              <span role="cell">{k.revoked ? t('Revoked') : k.expiresAt ? when(k.expiresAt) : t('Never')}</span>
              <span role="cell">{k.lastUsedAt ? `${when(k.lastUsedAt)}${k.lastUsedIp ? ` · ${k.lastUsedIp}` : ''}` : t('Never')}</span>
              <span role="cell">{canEdit && !k.revoked && <button type="button" className="studio-btn danger" onClick={() => void revoke(k.id)}>{t('Revoke')}</button>}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
