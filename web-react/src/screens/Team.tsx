import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from '../components/Icon'
import { InviteTeammate } from '../components/InviteTeammate'
import { Avatar } from '../components/Avatar'

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
  /// Called when this person is no longer in this workspace, so the shell can
  /// take them somewhere they still belong.
  onLeft: () => void
  onClose: () => void
}

interface Member {
  /// The handle a client is given. Not the login and not the account id —
  /// both of those are the person's email address for anyone who signed in
  /// with one, and this list is read by the whole team.
  ref: string
  name: string
  role: string
  title: string | null
  mine: boolean
  avatarUrl?: string | null
  /// A guest's channels (slugs): all they can see.
  channels?: string[]
}

interface Invite {
  ref: string
  /// Null for a code minted at a role above your own: reading it would be a
  /// promotion you could not otherwise grant. It can still be cancelled.
  code: string | null
  /// The link that carries the code — what is actually handed over.
  link: string | null
  role: string
  creator: string
  mine: boolean
  expiresAt: string | null
  uses: number
  maxUses: number
}

// English keys, translated where they are read — see utils/i18n.
const ROLE_LABEL: Record<string, string> = {
  founder: 'Founder / operator', operator: 'Ops / business',
  engineer: 'Engineer', designer: 'Designer', member: 'Member',
  admin: 'Admin', maintainer: 'Maintainer', triager: 'Triager', guest: 'Guest',
  owner: 'Owner',
}

/// An offer to hand the workspace on, as the server shows it to this viewer.
interface OwnerTransfer {
  from: { name: string; ref: string }
  to: { name: string; ref: string }
  stepDown: boolean
  expiresAt: string
  mine: 'from' | 'to' | null
}

/// Your team: who is here, what is still out, and one more way in.
///
/// Inviting was the whole of team management before this — you could add
/// someone and then never see them, never take them out, and never find the
/// code you handed over. The one endpoint that answered "who is here" read a
/// GitHub repository's collaborators, so for everyone who signed in with an
/// email address it answered nothing at all.
export const Team: React.FC<Props> = ({ httpBase, orgId, sessionToken, onLeft, onClose }) => {
  const t = useT()
  const [members, setMembers] = useState<Member[] | null>(null)
  const [editable, setEditable] = useState(true)
  // What the team calls itself, and whether this person may change it.
  const [teamName, setTeamName] = useState<string | null>(null)
  const [canRename, setCanRename] = useState(false)
  const [renaming, setRenaming] = useState(false)
  // The workspace's mark: set by an admin, shown on the rail.
  const [icon, setIcon] = useState<string | null>(null)
  const [iconBusy, setIconBusy] = useState(false)
  const iconInput = useRef<HTMLInputElement>(null)
  const [draftName, setDraftName] = useState('')
  const [invites, setInvites] = useState<Invite[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)
  // An admin managing one person: their role, a guest's channels, signing
  // them out everywhere.
  const [managing, setManaging] = useState<{ ref: string; role: string; channels: string[] } | null>(null)
  const [allChannels, setAllChannels] = useState<Array<{ slug: string; name: string }>>([])
  const [manageNote, setManageNote] = useState<string | null>(null)
  // Handing the workspace on: the standing offer, and the owner's draft of one.
  const [transfer, setTransfer] = useState<OwnerTransfer | null>(null)
  const [handTo, setHandTo] = useState('')
  const [stepDown, setStepDown] = useState(false)

  const headers = { 'x-session-token': sessionToken }
  const org = encodeURIComponent(orgId)

  const load = useCallback(async () => {
    try {
      const [m, i] = await Promise.all([
        fetch(`${httpBase}/members?orgId=${org}`, { headers }),
        fetch(`${httpBase}/invites?orgId=${org}`, { headers }),
      ])
      const mine = await m.json().catch(() => ({}))
      if (!m.ok) { setError(mine.message || t('Could not read your team.')); setMembers([]); return }
      setMembers(mine.members || [])
      setEditable(mine.editable !== false)
      setTeamName(typeof mine.name === 'string' ? mine.name : null)
      setCanRename(mine.canRename === true)
      setIcon(typeof mine.icon === 'string' ? mine.icon : null)
      setTransfer(mine.ownerTransfer || null)
      // The codes are the smaller half of this screen: failing to read them is
      // not a reason to show nothing about the people.
      if (i.ok) setInvites((await i.json().catch(() => ({}))).invites || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setMembers([])
    }
  }, [httpBase, org, sessionToken])
  useEffect(() => { load() }, [load])

  const remove = async (member: Member) => {
    setBusy(member.ref)
    setError(null)
    try {
      const res = await fetch(`${httpBase}/members`, {
        method: 'DELETE',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ orgId, ref: member.ref }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not work.')); return }
      setConfirm(null)
      if (data.left) { onLeft(); return }
      await load()
    } finally { setBusy(null) }
  }

  const manage = (m: Member) => {
    setManageNote(null); setError(null)
    setManaging(managing?.ref === m.ref ? null : { ref: m.ref, role: m.role, channels: m.channels || [] })
    if (!allChannels.length) {
      fetch(`${httpBase}/businesses?orgId=${org}`, { headers }).then((r) => r.json())
        .then((d) => setAllChannels((d.businesses || []).map((b: { slug: string; name: string }) => ({ slug: b.slug, name: b.name })))).catch(() => {})
    }
  }
  const saveRole = async () => {
    if (!managing) return
    setBusy(`role:${managing.ref}`); setError(null)
    try {
      const res = await fetch(`${httpBase}/members/role`, {
        method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ orgId, ref: managing.ref, role: managing.role, ...(managing.role === 'guest' ? { channels: managing.channels } : {}) }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not save.')); return }
      setManaging(null)
      await load()
    } finally { setBusy(null) }
  }
  const signOutEverywhere = async (m: Member) => {
    setBusy(`out:${m.ref}`); setManageNote(null)
    try {
      const res = await fetch(`${httpBase}/members/sessions`, {
        method: 'DELETE', headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ orgId, ref: m.ref }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not work.')); return }
      setManageNote(t('{name} was signed out of {n} devices.', { name: m.name, n: data.ended || 0 }))
    } finally { setBusy(null) }
  }

  const transferCall = async (path: string, method: string, body: Record<string, unknown>) => {
    setBusy('transfer'); setError(null)
    try {
      const res = await fetch(`${httpBase}${path}`, {
        method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ orgId, ...body }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not work.')); return }
      setHandTo(''); setStepDown(false)
      await load()
    } finally { setBusy(null) }
  }

  const revoke = async (invite: Invite) => {
    setBusy(invite.ref)
    setError(null)
    try {
      const res = await fetch(`${httpBase}/invites`, {
        method: 'DELETE',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ orgId, ref: invite.ref }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not work.')); return }
      await load()
    } finally { setBusy(null) }
  }

  const rename = async () => {
    const name = draftName.trim()
    if (!name) return
    setBusy('rename')
    setError(null)
    try {
      const res = await fetch(`${httpBase}/orgs/name`, {
        method: 'PUT',
        headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ orgId, name }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not save.')); return }
      setTeamName(data.name || name)
      window.dispatchEvent(new CustomEvent('honmaru:workspace'))
      setRenaming(false)
    } finally { setBusy(null) }
  }

  const myRole = (members || []).find((m) => m.mine)?.role || 'member'
  const isOwner = myRole === 'owner'
  const owners = (members || []).filter((m) => m.role === 'owner').length
  /// Whether this viewer may open someone's Manage panel: an admin for
  /// those below admin, an owner for everyone — themselves too, to step
  /// down, while another owner remains.
  const mayManage = (m: Member) => editable && canRename && (
    m.mine ? isOwner && owners > 1 : isOwner || !['admin', 'owner'].includes(m.role)
  )
  const rolesFor = (m: Member): string[] => m.mine
    ? ['member', 'admin']
    : isOwner ? ['guest', 'member', 'admin', 'owner'] : ['guest', 'member']

  const copy = (invite: Invite) => {
    if (!invite.link) return
    navigator.clipboard?.writeText(invite.link)
    setCopied(invite.ref)
    setTimeout(() => setCopied(null), 1500)
  }

  const uploadIcon = async (file: File) => {
    setIconBusy(true); setError(null)
    try {
      const res = await fetch(`${httpBase}/orgs/icon?orgId=${encodeURIComponent(orgId)}`, {
        method: 'POST',
        headers: { 'content-type': file.type || 'image/png', 'x-session-token': sessionToken },
        body: file,
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not save.')); return }
      setIcon(data.icon || null)
      window.dispatchEvent(new CustomEvent('honmaru:workspace'))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setIconBusy(false) }
  }
  const removeIcon = async () => {
    setIconBusy(true); setError(null)
    try {
      const res = await fetch(`${httpBase}/orgs/icon?orgId=${encodeURIComponent(orgId)}`, { method: 'DELETE', headers: { 'x-session-token': sessionToken } })
      if (!res.ok) { setError(t('That did not save.')); return }
      setIcon(null)
      window.dispatchEvent(new CustomEvent('honmaru:workspace'))
    } finally { setIconBusy(false) }
  }

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="back" onClick={onClose} aria-label={t('Close')}>‹</button>
        <span className="head-title">{t('Your team')}</span>
      </div>
      <div className="screen-body">
        {error && <div className="form-error">{error}</div>}

        {/* The name on the door. A repository is named by GitHub; a team
            made here, or the workspace a sign-up handed out, is named by
            its admins — and until it is, it is "your workspace". */}
        <div className="team-name-row">
          <span className="team-logo">
            {icon
              ? <img src={icon} alt="" width={44} height={44} />
              : <span className="team-logo-letter" aria-hidden="true">{((teamName || orgId)[0] || '?').toUpperCase()}</span>}
          </span>
          {renaming ? (
            <form className="team-rename" onSubmit={(e) => { e.preventDefault(); void rename() }}>
              <input
                className="team-name-input"
                value={draftName}
                onChange={(e) => setDraftName(e.target.value)}
                placeholder={t('Team name')}
                aria-label={t('Team name')}
                maxLength={60}
                autoFocus
              />
              <button type="submit" className="pill-btn" disabled={busy === 'rename' || !draftName.trim()}>{t('Save')}</button>
              <button type="button" className="btn-text" onClick={() => setRenaming(false)}>{t('Cancel')}</button>
            </form>
          ) : (
            <>
              <h1 className="team-name">{teamName || (orgId.includes('/') ? orgId : t('Your workspace'))}</h1>
              {canRename && (
                <button className="btn-text team-rename-btn" onClick={() => { setDraftName(teamName || ''); setRenaming(true) }}>
                  {teamName ? t('Rename') : t('Name it')}
                </button>
              )}
            </>
          )}
        </div>

        {canRename && (
          <div className="team-logo-row">
            <input
              ref={iconInput}
              type="file"
              accept="image/png,image/jpeg,image/webp,image/gif"
              className="team-logo-input"
              aria-label={t('Workspace logo')}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void uploadIcon(f); e.target.value = '' }}
            />
            <button className="btn-text" disabled={iconBusy} onClick={() => iconInput.current?.click()}>
              {iconBusy ? t('Uploading…') : icon ? t('Change logo') : t('Upload a logo')}
            </button>
            {icon && <button className="btn-text danger" disabled={iconBusy} onClick={() => void removeIcon()}>{t('Remove logo')}</button>}
            <span className="row-sub">{t('PNG, JPEG, WebP or GIF, up to 2 MB. Shown at the top of the rail and in the workspace switcher.')}</span>
          </div>
        )}

        <div className="rows-title">{t('Who is here')}</div>
        {members === null && <div className="empty">{t('One moment…')}</div>}
        <div className="rows">
          {(members || []).map((m) => (
            <div className="row static team-member" key={m.ref} data-member={m.ref}>
              <Avatar name={m.name || '?'} url={m.avatarUrl} size={34} round />
              <span className="row-main">
                {m.name}
                {m.role === 'owner' && <span className="team-crown" title={t('Owner')} aria-label={t('Owner')}><Icon name="crown" size={12} /></span>}
                <span className="row-sub">
                  {t(ROLE_LABEL[m.role] || m.role)}
                  {m.mine && ` · ${t('you')}`}
                  {m.role === 'guest' && m.channels && ` · ${m.channels.map((c) => `#${allChannels.find((x) => x.slug === c)?.name || c}`).join(' ')}`}
                </span>
              </span>
              {editable && (
                confirm === m.ref ? (
                  <span className="team-confirm">
                    <button className="pill-btn" disabled={busy === m.ref} onClick={() => remove(m)}>
                      {m.mine ? t('Leave') : t('Remove')}
                    </button>
                    <button className="btn-text" onClick={() => setConfirm(null)}>{t('Keep')}</button>
                  </span>
                ) : (
                  <button className="btn-text" onClick={() => { setError(null); setConfirm(m.ref) }}>
                    {m.mine ? t('Leave') : t('Remove')}
                  </button>
                )
              )}
              {mayManage(m) && (
                <button className="btn-text team-manage" aria-expanded={managing?.ref === m.ref} onClick={() => manage(m)}>{t('Manage')}</button>
              )}
              {managing?.ref === m.ref && (
                <div className="team-manage-panel" data-manage={m.ref}>
                  <div className="dlg-seg" role="radiogroup" aria-label={t('Role')}>
                    {rolesFor(m).map((r) => (
                      <button key={r} type="button" role="radio" aria-checked={managing.role === r} data-role={r}
                        onClick={() => setManaging({ ...managing, role: r })}>
                        <b>{t(ROLE_LABEL[r])}</b>
                        <span>{r === 'guest' ? t('Only the channels you choose') : r === 'member' ? t('Every public channel') : r === 'admin' ? t('Manages the workspace') : t('Holds the workspace: security, keys, owners')}</span>
                      </button>
                    ))}
                  </div>
                  {managing.role === 'guest' && (
                    <div className="team-guest-channels">
                      <div className="dlg-label">{t('Channels this guest can see')}</div>
                      {allChannels.map((c) => (
                        <label key={c.slug} className="dlg-check">
                          <input type="checkbox" data-guest-channel={c.slug} checked={managing.channels.includes(c.slug)}
                            onChange={() => setManaging({ ...managing, channels: managing.channels.includes(c.slug) ? managing.channels.filter((x) => x !== c.slug) : [...managing.channels, c.slug] })} />
                          # {c.name}
                        </label>
                      ))}
                    </div>
                  )}
                  <div className="team-manage-actions">
                    <button className="pill-btn team-role-save" disabled={busy === `role:${m.ref}` || (managing.role === 'guest' && !managing.channels.length)} onClick={() => void saveRole()}>{t('Save')}</button>
                    <button className="btn-text" onClick={() => setManaging(null)}>{t('Cancel')}</button>
                    <span style={{ flex: 1 }} />
                    {!m.mine && <button className="btn-text danger team-signout" disabled={busy === `out:${m.ref}`} onClick={() => void signOutEverywhere(m)}>
                      <Icon name="log-out" size={13} /> {t('Sign out of every device')}
                    </button>}
                  </div>
                  {manageNote && <p className="row-sub" role="status">{manageNote}</p>}
                </div>
              )}
            </div>
          ))}
        </div>
        {!editable && (
          <p className="hint team-hint">
            {t("This workspace's members come from a GitHub repository. Change who can push to it there.")}
          </p>
        )}

        {invites.length > 0 && (
          <>
            <div className="rows-title">{t('Links you have out')}</div>
            <div className="rows">
              {invites.map((i) => (
                <div className="row static team-invite" key={i.ref} data-invite={i.ref} data-code={i.code || ''}>
                  <span className="row-main">
                    {i.link
                      ? <a className="invite-out-link" href={i.link} onClick={(e) => e.preventDefault()}>{i.link.replace(/^https?:\/\//, '')}</a>
                      : <code className="invite-code sm">{`${i.ref.slice(0, 6)}…`}</code>}
                    <span className="row-sub">
                      {t(ROLE_LABEL[i.role] || i.role)}
                      {' · '}
                      {i.mine ? t('yours') : t('from {name}', { name: i.creator })}
                      {i.expiresAt && ` · ${t('until {when}', { when: new Date(i.expiresAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) })}`}
                      {/* A link is for whoever it is shared with, so it says who came
                          in by it, not a quota. */}
                      {i.maxUses > 1 ? (i.uses > 0 ? ` · ${t('{n} joined', { n: i.uses })}` : ` · ${t('anyone with the link')}`) : ` · ${t('one person')}`}
                    </span>
                  </span>
                  {i.link && (
                    <button className="btn-text" onClick={() => copy(i)}>
                      {copied === i.ref ? t('Copied!') : t('Copy')}
                    </button>
                  )}
                  <button className="btn-text danger" disabled={busy === i.ref} onClick={() => revoke(i)}>
                    {t('Revoke')}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}

        {transfer && (
          <div className="team-transfer-offer" data-owner-offer={transfer.mine || 'other'} role="status">
            <Icon name="crown" size={16} />
            <span className="row-main">
              {transfer.mine === 'to'
                ? t('{name} would like you to become an owner of this workspace.', { name: transfer.from.name })
                : t('{from} offered this workspace to {to}. Waiting for them to accept.', { from: transfer.from.name, to: transfer.to.name })}
              {transfer.stepDown && <span className="row-sub">{t('{name} becomes an admin once it is accepted.', { name: transfer.from.name })}</span>}
            </span>
            {transfer.mine === 'to' && (
              <button className="pill-btn" data-accept-owner disabled={busy === 'transfer'} onClick={() => void transferCall('/members/owner-transfer/accept', 'POST', {})}>{t('Accept')}</button>
            )}
            {(transfer.mine || isOwner) && (
              <button className="btn-text" disabled={busy === 'transfer'} onClick={() => void transferCall('/members/owner-transfer', 'DELETE', {})}>
                {transfer.mine === 'to' ? t('Decline') : t('Call it off')}
              </button>
            )}
          </div>
        )}

        <div className="rows-title">{t('Invite a teammate')}</div>
        <div className="team-invite-form">
          <InviteTeammate
            relayHttpUrl={httpBase}
            orgId={orgId}
            sessionToken={sessionToken}
            onMinted={load}
            canInviteAdmin={isOwner || orgId.includes('/')}
          />
        </div>

        {/* Handing it on is an owner's, and the person named has to say yes. */}
        {editable && isOwner && !transfer && (
          <>
            <div className="rows-title">{t('Hand the workspace on')}</div>
            <div className="team-transfer">
              <select className="dlg-input" value={handTo} onChange={(e) => setHandTo(e.target.value)} aria-label={t('Who should own it')} data-hand-to>
                <option value="">{t('Choose someone…')}</option>
                {(members || []).filter((m) => !m.mine && m.role !== 'owner' && m.role !== 'guest').map((m) => (
                  <option key={m.ref} value={m.ref}>{m.name}</option>
                ))}
              </select>
              <label className="dlg-check">
                <input type="checkbox" checked={stepDown} onChange={(e) => setStepDown(e.target.checked)} />
                {t('Become an admin once they accept')}
              </label>
              <button className="pill-btn" data-offer-owner disabled={!handTo || busy === 'transfer'} onClick={() => void transferCall('/members/owner-transfer', 'POST', { ref: handTo, stepDown })}>{t('Offer it')}</button>
              <span className="row-sub">{t('They become an owner when they accept. Every owner is told by email.')}</span>
            </div>
          </>
        )}

        <div className="rows-title">{t('Always on')}</div>
        <div className="rows">
          <div className="row static">
            <span className="row-icon"><Icon name="invite" size={18} /></span>
            <span className="row-main">
              {t('Everyone here gets their own AI')}
              <span className="row-sub">{t('A decision reaches them wherever they read, in their own language.')}</span>
            </span>
          </div>
        </div>
        <div style={{ height: 32 }} />
      </div>
    </div>
  )
}
