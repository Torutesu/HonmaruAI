import React, { useEffect, useState } from 'react'
import { getLocale, LOCALE_NAMES } from '../utils/locale'
import type { Business } from '../types/card'
import { useT, changeLocale as applyLocale } from '../utils/i18n'
import { Icon } from '../components/Icon'

interface Props {
  httpBase: string
  orgId: string
  userId: string
  sessionToken: string
  businesses: Business[]
  pendingCount: number
  decidedCount: number
  onOpen: (screen: 'tools' | 'notifications' | 'history' | 'plans' | 'record' | 'invite') => void
  onLocaleChange: () => void
  onSwitchOrg: (orgId: string) => void
  onLogout: () => void
  onClose: () => void
}

/// One workspace this person belongs to. `founder` stands in for a name a
/// workspace made at sign-up does not have — `personal:8f3a…` is an id, not
/// something to put on a screen.
interface Org {
  id: string
  role: string
  founder: string | null
  mine: boolean
}

interface Me {
  name: string
  login: string
  email: string | null
  locale: string
  role: string | null
  assignableRoles: string[]
  orgs?: Org[]
}

// English keys, translated where they are read — see utils/i18n.
const ROLE_LABEL: Record<string, string> = {
  founder: 'Founder / operator', operator: 'Ops / business',
  engineer: 'Engineer', designer: 'Designer', member: 'Member',
  admin: 'Admin', maintainer: 'Maintainer', triager: 'Triager',
}

/// You: who your AI thinks you are, what it has done for you, and the way out.
export const Profile: React.FC<Props> = ({
  httpBase, orgId, userId, sessionToken, businesses, pendingCount, decidedCount,
  onOpen, onLocaleChange, onSwitchOrg, onLogout, onClose,
}) => {
  const t = useT()
  const [me, setMe] = useState<Me | null>(null)
  const [locale, setLocaleState] = useState(getLocale())
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  // Redeeming a code from inside the app. Until this existed, an invite only
  // worked on the day you made your account: the sign-in screen took a code,
  // and nothing anywhere took one from a person who was already signed in.
  const [joining, setJoining] = useState(false)
  const [joinCode, setJoinCode] = useState('')
  const [joinError, setJoinError] = useState<string | null>(null)

  useEffect(() => {
    fetch(`${httpBase}/me?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      .then((r) => r.json())
      .then((data) => { setMe(data); if (data.locale) setLocaleState(data.locale) })
      .catch(() => setError(t('Could not read your profile.')))
  }, [httpBase, orgId, sessionToken])

  const patch = async (body: Record<string, unknown>) => {
    const res = await fetch(`${httpBase}/me`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data.message || t('That did not save.')); return }
    setError(null)
    setMe((prev) => (prev ? { ...prev, ...data } : prev))
  }

  const changeLocale = (code: string) => {
    setLocaleState(code)
    // Through i18n, not straight to storage: it is what repaints the interface.
    // Writing the preference alone changed the notifications and left every
    // label on the screen in English, which reads as a setting that does not work.
    applyLocale(code)
    patch({ locale: code })
    onLocaleChange()
  }

  const join = async () => {
    setJoinError(null)
    const code = joinCode.trim()
    if (!code) return
    try {
      const res = await fetch(`${httpBase}/invites/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ code }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setJoinError(data.message || t('That invite code is not valid.')); return }
      setJoinCode('')
      setJoining(false)
      onSwitchOrg(data.orgId)
    } catch (err) {
      setJoinError(err instanceof Error ? err.message : String(err))
    }
  }

  /// What to call a workspace. A repository org is already readable; one made
  /// at sign-up is `personal:<hash>`, so whoever started it stands in for a
  /// name — "yours", or "Dana's team".
  const orgLabel = (org: Org) => {
    if (org.id.includes('/')) return org.id
    if (org.mine) return t('Your workspace')
    return org.founder ? t("{name}'s team", { name: org.founder }) : t('A team you joined')
  }

  const deleteAccount = async () => {
    const res = await fetch(`${httpBase}/account`, {
      method: 'DELETE',
      headers: { 'x-session-token': sessionToken },
    })
    if (res.ok) onLogout()
    else setError(t('That did not work. Try again in a moment.'))
  }

  const handle = (me?.login || userId).replace(/^(u:|email:)/, '')
  const display = me?.name || handle.split('@')[0]

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="back" onClick={onClose} aria-label={t('Close')}>‹</button>
        <span className="head-title">{t('You')}</span>
      </div>
      <div className="screen-body">
        <div className="profile-head">
          <div className="profile-avatar">{(display[0] || '?').toUpperCase()}</div>
          <div>
            <b>{display}</b>
            <span>{me?.email || handle}</span>
          </div>
        </div>

        <div className="profile-stats">
          <div><b>{pendingCount}</b><span>{t('waiting')}</span></div>
          <div><b>{decidedCount}</b><span>{t('decided')}</span></div>
          <div><b>{businesses.length}</b><span>{t('businesses')}</span></div>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="rows-title">{t('How your AI treats you')}</div>
        <div className="rows">
          <div className="row static">
            <span className="row-main">
              {t('Role')}
              <span className="row-sub">{t('What gets routed to you first.')}</span>
            </span>
            {me && me.assignableRoles?.includes(me.role || '') ? (
              <select
                className="row-select"
                value={me.role || 'member'}
                onChange={(e) => patch({ role: e.target.value, orgId })}
                aria-label={t('Role')}
              >
                {me.assignableRoles.map((r) => <option key={r} value={r}>{t(ROLE_LABEL[r] || r)}</option>)}
              </select>
            ) : (
              <span className="row-value">{me?.role ? t(ROLE_LABEL[me.role] || me.role) : '—'}</span>
            )}
          </div>
          <div className="row static">
            <span className="row-main">
              {t('Language')}
              <span className="row-sub">{t('Every notification arrives written in it.')}</span>
            </span>
            <select className="row-select" value={locale} onChange={(e) => changeLocale(e.target.value)} aria-label={t('Language')}>
              {Object.entries(LOCALE_NAMES).map(([code, label]) => (
                <option key={code} value={code}>{label}</option>
              ))}
            </select>
          </div>
        </div>

        {(me?.orgs?.length || 0) > 1 && (
          <>
            <div className="rows-title">{t('Where you work')}</div>
            <div className="rows">
              {me!.orgs!.map((org) => (
                <button
                  key={org.id}
                  className="row"
                  data-org={org.id}
                  aria-current={org.id === orgId}
                  onClick={() => { if (org.id !== orgId) onSwitchOrg(org.id) }}
                >
                  <span className="row-main">
                    {orgLabel(org)}
                    <span className="row-sub">{t(ROLE_LABEL[org.role] || org.role)}</span>
                  </span>
                  <span className="row-value">{org.id === orgId ? '✓' : '›'}</span>
                </button>
              ))}
            </div>
          </>
        )}

        <div className="rows-title">{t('Your workspace')}</div>
        <div className="rows">
          <button className="row" onClick={() => onOpen('history')}>
            <span className="row-icon"><Icon name="history" size={18} /></span>
            <span className="row-main">{t('History')}<span className="row-sub">{t('Everything already settled.')}</span></span>
            <span className="row-value">›</span>
          </button>
          <button className="row" onClick={() => onOpen('record')}>
            <span className="row-icon"><Icon name="record" size={18} /></span>
            <span className="row-main">{t('The record')}<span className="row-sub">{t('Every decision, by business, written by nobody.')}</span></span>
            <span className="row-value">›</span>
          </button>
          <button className="row" onClick={() => onOpen('tools')}>
            <span className="row-icon"><Icon name="tools" size={18} /></span>
            <span className="row-main">{t('Tools')}<span className="row-sub">{t('Gmail, Slack, Notion, GitHub.')}</span></span>
            <span className="row-value">›</span>
          </button>
          <button className="row" onClick={() => onOpen('notifications')}>
            <span className="row-icon"><Icon name="bell" size={18} /></span>
            <span className="row-main">{t('Notifications')}<span className="row-sub">{t('Where a decision reaches you.')}</span></span>
            <span className="row-value">›</span>
          </button>
          <button className="row" onClick={() => onOpen('invite')}>
            <span className="row-icon"><Icon name="invite" size={18} /></span>
            <span className="row-main">{t('Invite a teammate')}<span className="row-sub">{t('They get their own AI, in this workspace.')}</span></span>
            <span className="row-value">›</span>
          </button>
          <button className="row join-team" onClick={() => { setJoining(!joining); setJoinError(null) }}>
            <span className="row-icon"><Icon name="invite" size={18} /></span>
            <span className="row-main">{t('Join a team')}<span className="row-sub">{t('Paste a code somebody sent you.')}</span></span>
            <span className="row-value">{joining ? '⌄' : '›'}</span>
          </button>
          {joining && (
            <div className="row static">
              <input
                className="join-code"
                value={joinCode}
                onChange={(e) => setJoinCode(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') join() }}
                placeholder={t('Invite code')}
                aria-label={t('Invite code')}
              />
              <button className="pill-btn" onClick={join} disabled={!joinCode.trim()}>{t('Join')}</button>
            </div>
          )}
          {joinError && <div className="form-error">{joinError}</div>}
          <button className="row" onClick={() => onOpen('plans')}>
            <span className="row-icon"><Icon name="plan" size={18} /></span>
            <span className="row-main">{t('Plan')}<span className="row-sub">{t('What you are on, and what else there is.')}</span></span>
            <span className="row-value">›</span>
          </button>
        </div>

        {businesses.length > 0 && (
          <>
            <div className="rows-title">{t('Businesses your AI has found')}</div>
            <div className="chips">
              {businesses.map((b) => <span key={b.slug} className="pill-tag">{b.name}</span>)}
            </div>
            <p className="hint" style={{ margin: '8px 4px 20px', color: 'var(--ash)', fontSize: 12.5 }}>
              {t('businesses.blurb')}
            </p>
          </>
        )}

        <div className="rows">
          <button className="row" onClick={onLogout}>
            <span className="row-main" style={{ color: 'var(--slate)' }}>{t('Sign out')}</span>
          </button>
          <button className="row" onClick={() => setConfirmDelete(true)}>
            <span className="row-main" style={{ color: '#a11258' }}>{t('Delete account')}</span>
          </button>
        </div>

        {confirmDelete && (
          <div className="form-error">
            This removes your account and your cards. Decisions other people
            made stay in their record — those are theirs, not yours.
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>{t('Keep it')}</button>
              <button className="btn btn-primary" onClick={deleteAccount}>{t('Delete')}</button>
            </div>
          </div>
        )}
        <div style={{ height: 32 }} />
      </div>
    </div>
  )
}
