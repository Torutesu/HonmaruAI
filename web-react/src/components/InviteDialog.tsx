import React, { useEffect, useMemo, useState } from 'react'
import { useT } from '../utils/i18n'
import { Dialog } from './Dialog'
import { Icon } from './Icon'

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
  /// The workspace's name, for the title.
  orgName?: string | null
  initialTab?: 'people' | 'agent'
  onClose: () => void
}

interface Channel { slug: string; name: string }

/// Bringing people — or an agent — into the workspace, in one place.
///
/// People: addresses to mail an invitation to, or a link to copy and hand
/// over; either way they are introduced in the channels ticked here when
/// they join. An agent: a link that works once, for fifteen minutes, which
/// the agent opens to get its own MCP token.
export const InviteDialog: React.FC<Props> = ({ httpBase, orgId, sessionToken, orgName, initialTab = 'people', onClose }) => {
  const t = useT()
  const headers = useMemo(() => ({ 'content-type': 'application/json', 'x-session-token': sessionToken }), [sessionToken])
  const [tab, setTab] = useState<'people' | 'agent'>(initialTab)
  const [channels, setChannels] = useState<Channel[] | null>(null)
  const [picked, setPicked] = useState<Set<string>>(new Set())
  const [query, setQuery] = useState('')
  const [emails, setEmails] = useState('')
  const [busy, setBusy] = useState<'send' | 'link' | 'agent' | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [agentLink, setAgentLink] = useState<{ url: string; expiresAt: string } | null>(null)
  // A member sees every public channel; a guest only the ones ticked.
  const [role, setRole] = useState<'member' | 'guest'>('member')

  useEffect(() => {
    let ignore = false
    fetch(`${httpBase}/businesses?orgId=${encodeURIComponent(orgId)}`, { headers })
      .then((r) => (r.ok ? r.json() : { businesses: [] }))
      .then((data) => {
        if (ignore) return
        const list: Channel[] = (data.businesses || []).map((b: { slug: string; name: string }) => ({ slug: b.slug, name: b.name }))
        setChannels(list)
        // Everywhere, until somebody says otherwise — as a new colleague is
        // introduced to the whole office.
        setPicked(new Set(list.map((c) => c.slug)))
      })
      .catch(() => { if (!ignore) setChannels([]) })
    return () => { ignore = true }
  }, [httpBase, orgId, headers])

  const shown = (channels || []).filter((c) => !query.trim() || c.name.toLowerCase().includes(query.trim().toLowerCase()))
  const allPicked = Boolean(channels?.length) && channels!.every((c) => picked.has(c.slug))
  const toggle = (slug: string) => setPicked((p) => { const n = new Set(p); if (n.has(slug)) n.delete(slug); else n.add(slug); return n })
  const toggleAll = () => setPicked(allPicked ? new Set() : new Set((channels || []).map((c) => c.slug)))
  const chosen = () => [...picked]

  const copy = async (text: string) => {
    try { await navigator.clipboard?.writeText(text); return true } catch { return false }
  }
  const addresses = emails.split(/[\s,、;]+/).map((e) => e.trim()).filter(Boolean)

  const sendInvites = async () => {
    if (!addresses.length) return
    setBusy('send'); setError(null); setNote(null)
    const failed: string[] = []
    let sent = 0
    for (const email of addresses.slice(0, 20)) {
      try {
        const res = await fetch(`${httpBase}/invites/email`, {
          method: 'POST', headers, body: JSON.stringify({ orgId, role, email, channels: chosen() }),
        })
        if (res.ok) sent += 1
        else failed.push(`${email}: ${(await res.json().catch(() => ({}))).message || res.status}`)
      } catch (err) { failed.push(`${email}: ${err instanceof Error ? err.message : String(err)}`) }
    }
    setBusy(null)
    if (sent) { setNote(sent === 1 ? t('Invitation sent to {email}.', { email: addresses[0] }) : t('{n} invitations sent.', { n: sent })); setEmails('') }
    if (failed.length) setError(failed.join(' · '))
  }

  const copyInviteUrl = async () => {
    setBusy('link'); setError(null); setNote(null)
    try {
      const res = await fetch(`${httpBase}/invites/create`, { method: 'POST', headers, body: JSON.stringify({ orgId, role, channels: chosen() }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.link) { setError(data.message || t('Could not create invite.')); return }
      setNote((await copy(data.link)) ? t('Invite link copied. Anyone who opens it within three days joins.') : data.link)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(null) }
  }

  const copyAgentLink = async () => {
    setBusy('agent'); setError(null); setNote(null)
    try {
      const res = await fetch(`${httpBase}/agents/invite`, { method: 'POST', headers, body: JSON.stringify({ orgId, channels: chosen() }) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.url) { setError(data.message || t('Could not create the link.')); return }
      setAgentLink({ url: data.url, expiresAt: data.expiresAt })
      if (await copy(data.url)) setNote(t('Link copied.'))
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(null) }
  }

  const picklist = (
    <div>
      <div className="dlg-label">{tab === 'people' ? t('Add to channels') : t('Introduce in channels')}</div>
      <div className="dlg-picklist" data-channels="1">
        <div className="dlg-picklist-search">
          <Icon name="search" size={14} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Search channels')} aria-label={t('Search channels')} />
        </div>
        <ul>
          {channels === null && <li className="dlg-empty">{t('Loading…')}</li>}
          {channels && channels.length === 0 && <li className="dlg-empty">{t('No channels yet.')}</li>}
          {channels && channels.length > 0 && !query.trim() && (
            <li><label className="dlg-pick-all"><input type="checkbox" checked={allPicked} onChange={toggleAll} />{t('Select all')}</label></li>
          )}
          {shown.map((c) => (
            <li key={c.slug}>
              <label>
                <input type="checkbox" checked={picked.has(c.slug)} onChange={() => toggle(c.slug)} />
                <span className="dlg-pick-mark" aria-hidden="true"><Icon name="hash" size={13} /></span>
                {c.name}
              </label>
            </li>
          ))}
        </ul>
      </div>
      <p className="dlg-hint">{tab === 'agent'
        ? t('The ones ticked say hello when the agent joins.')
        : role === 'guest'
          ? t('A guest sees only the channels ticked here — nothing else in the workspace.')
          : t('Every channel is open to the whole workspace; the ones ticked say hello when they join.')}</p>
    </div>
  )

  const art = (
    <span className="invite-art" aria-hidden="true">
      <Icon name="mail" size={26} />
      <i className="spark a" /><i className="spark b" />
    </span>
  )

  return (
    <Dialog
      className="invite-dialog"
      title={orgName ? t('Invite to {name}', { name: orgName }) : t('Invite to your workspace')}
      lede={t('Bring people and agents into your workspace.')}
      art={art}
      onClose={onClose}
      footer={tab === 'people' ? (
        <>
          <button type="button" className="dlg-btn link invite-copy-url" onClick={() => void copyInviteUrl()} disabled={busy !== null || (role === 'guest' && picked.size === 0)}>
            <Icon name="link" size={14} /> {busy === 'link' ? t('Creating…') : t('Copy invite URL')}
          </button>
          <span style={{ flex: 1 }} />
          <button type="button" className="dlg-btn" onClick={onClose}>{t('Cancel')}</button>
          <button type="button" className="dlg-btn primary invite-send" onClick={() => void sendInvites()} disabled={busy !== null || !addresses.length || (role === 'guest' && picked.size === 0)}>
            {busy === 'send' ? t('Sending…') : t('Send invites')}
          </button>
        </>
      ) : undefined}
    >
      <div className="dlg-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'people'} onClick={() => { setTab('people'); setNote(null); setError(null) }}>{t('People')}</button>
        <button type="button" role="tab" aria-selected={tab === 'agent'} data-tab-agent="1" onClick={() => { setTab('agent'); setNote(null); setError(null) }}>{t('Agent')}</button>
      </div>

      {tab === 'people' && (
        <div>
          <div className="dlg-label">{t('Invite as')}</div>
          <div className="dlg-seg invite-role" role="radiogroup" aria-label={t('Invite as')}>
            <button type="button" role="radio" aria-checked={role === 'member'} data-invite-role="member" onClick={() => setRole('member')}>
              <b>{t('Member')}</b><span>{t('Every public channel')}</span>
            </button>
            <button type="button" role="radio" aria-checked={role === 'guest'} data-invite-role="guest"
              onClick={() => { if (role !== 'guest') { setRole('guest'); setPicked(new Set()) } }}>
              <b>{t('Guest')}</b><span>{t('Only the channels you choose')}</span>
            </button>
          </div>
          <label className="dlg-label" htmlFor="invite-emails">{t('Invite by email')}</label>
          <input
            id="invite-emails"
            className="dlg-input invite-emails"
            value={emails}
            onChange={(e) => setEmails(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void sendInvites() } }}
            placeholder="name@company.com, …"
            inputMode="email"
            autoComplete="off"
          />
        </div>
      )}

      {picklist}

      {tab === 'agent' && (
        <div className="invite-agent">
          <p className="dlg-note">{t('Send this link to an agent to add it to the workspace. It gets its own MCP token, acting for you.')}</p>
          {agentLink && (
            <div className="dlg-secret" data-agent-link="1">
              <code>{agentLink.url}</code>
              <button type="button" className="dlg-btn" onClick={() => void copy(agentLink.url).then((ok) => ok && setNote(t('Link copied.')))}><Icon name="copy" size={13} /> {t('Copy')}</button>
            </div>
          )}
          <div>
            <button type="button" className="dlg-btn primary invite-agent-link" onClick={() => void copyAgentLink()} disabled={busy !== null}>
              {busy === 'agent' ? t('Creating…') : agentLink ? t('Make another link') : t('Copy single-use link')}
            </button>
          </div>
          <p className="dlg-hint">{t('Single use · expires in 15 minutes')}</p>
        </div>
      )}

      {note && <p className="dlg-note invite-note" role="status">{note}</p>}
      {error && <p className="dlg-error" role="alert">{error}</p>}
    </Dialog>
  )
}
