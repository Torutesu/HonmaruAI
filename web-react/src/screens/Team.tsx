import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from '../components/Icon'
import { InviteTeammate } from '../components/InviteTeammate'

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
}

interface Invite {
  ref: string
  /// Null for a code minted at a role above your own: reading it would be a
  /// promotion you could not otherwise grant. It can still be cancelled.
  code: string | null
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
  admin: 'Admin', maintainer: 'Maintainer', triager: 'Triager',
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
  const [invites, setInvites] = useState<Invite[]>([])
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [copied, setCopied] = useState<string | null>(null)

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

  const copy = (invite: Invite) => {
    if (!invite.code) return
    navigator.clipboard?.writeText(invite.code)
    setCopied(invite.ref)
    setTimeout(() => setCopied(null), 1500)
  }

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="back" onClick={onClose} aria-label={t('Close')}>‹</button>
        <span className="head-title">{t('Your team')}</span>
      </div>
      <div className="screen-body">
        {error && <div className="form-error">{error}</div>}

        <div className="rows-title">{t('Who is here')}</div>
        {members === null && <div className="empty">{t('One moment…')}</div>}
        <div className="rows">
          {(members || []).map((m) => (
            <div className="row static team-member" key={m.ref} data-member={m.ref}>
              <span className="profile-avatar sm">{(m.name || '?')[0]?.toUpperCase() || '?'}</span>
              <span className="row-main">
                {m.name}
                <span className="row-sub">
                  {t(ROLE_LABEL[m.role] || m.role)}
                  {m.mine && ` · ${t('you')}`}
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
            <div className="rows-title">{t('Codes you have out')}</div>
            <div className="rows">
              {invites.map((i) => (
                <div className="row static team-invite" key={i.ref} data-invite={i.ref}>
                  <span className="row-main">
                    <code className="invite-code sm">{i.code || `${i.ref.slice(0, 6)}…`}</code>
                    <span className="row-sub">
                      {t(ROLE_LABEL[i.role] || i.role)}
                      {' · '}
                      {i.mine ? t('yours') : t('from {name}', { name: i.creator })}
                      {i.maxUses > 1 && ` · ${i.uses}/${i.maxUses}`}
                    </span>
                  </span>
                  {i.code && (
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

        <div className="rows-title">{t('Invite a teammate')}</div>
        <div className="team-invite-form">
          <InviteTeammate
            relayHttpUrl={httpBase}
            orgId={orgId}
            sessionToken={sessionToken}
            onMinted={load}
          />
        </div>

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
