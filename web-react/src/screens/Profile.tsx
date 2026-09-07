import React, { useEffect, useState } from 'react'
import { getLocale, setLocale as storeLocale, LOCALE_NAMES } from '../utils/locale'
import type { Business } from '../types/card'

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
  onLogout: () => void
  onClose: () => void
}

interface Me {
  name: string
  login: string
  email: string | null
  locale: string
  role: string | null
  assignableRoles: string[]
}

const ROLE_LABEL: Record<string, string> = {
  founder: 'Founder / operator', operator: 'Ops / business',
  engineer: 'Engineer', designer: 'Designer', member: 'Member',
  admin: 'Admin', maintainer: 'Maintainer', triager: 'Triager',
}

/// You: who your AI thinks you are, what it has done for you, and the way out.
export const Profile: React.FC<Props> = ({
  httpBase, orgId, userId, sessionToken, businesses, pendingCount, decidedCount,
  onOpen, onLocaleChange, onLogout, onClose,
}) => {
  const [me, setMe] = useState<Me | null>(null)
  const [locale, setLocaleState] = useState(getLocale())
  const [error, setError] = useState<string | null>(null)
  const [confirmDelete, setConfirmDelete] = useState(false)

  useEffect(() => {
    fetch(`${httpBase}/me?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      .then((r) => r.json())
      .then((data) => { setMe(data); if (data.locale) setLocaleState(data.locale) })
      .catch(() => setError('Could not read your profile.'))
  }, [httpBase, orgId, sessionToken])

  const patch = async (body: Record<string, unknown>) => {
    const res = await fetch(`${httpBase}/me`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data.message || 'That did not save.'); return }
    setError(null)
    setMe((prev) => (prev ? { ...prev, ...data } : prev))
  }

  const changeLocale = (code: string) => {
    setLocaleState(code)
    storeLocale(code)
    patch({ locale: code })
    onLocaleChange()
  }

  const deleteAccount = async () => {
    const res = await fetch(`${httpBase}/account`, {
      method: 'DELETE',
      headers: { 'x-session-token': sessionToken },
    })
    if (res.ok) onLogout()
    else setError('That did not work. Try again in a moment.')
  }

  const handle = (me?.login || userId).replace(/^(u:|email:)/, '')
  const display = me?.name || handle.split('@')[0]

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="back" onClick={onClose} aria-label="Close">‹</button>
        <span className="head-title">You</span>
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
          <div><b>{pendingCount}</b><span>waiting</span></div>
          <div><b>{decidedCount}</b><span>decided</span></div>
          <div><b>{businesses.length}</b><span>businesses</span></div>
        </div>

        {error && <div className="form-error">{error}</div>}

        <div className="rows-title">How your AI treats you</div>
        <div className="rows">
          <div className="row static">
            <span className="row-main">
              Role
              <span className="row-sub">What gets routed to you first.</span>
            </span>
            {me && me.assignableRoles?.includes(me.role || '') ? (
              <select
                className="row-select"
                value={me.role || 'member'}
                onChange={(e) => patch({ role: e.target.value, orgId })}
                aria-label="Role"
              >
                {me.assignableRoles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r] || r}</option>)}
              </select>
            ) : (
              <span className="row-value">{ROLE_LABEL[me?.role || ''] || me?.role || '—'}</span>
            )}
          </div>
          <div className="row static">
            <span className="row-main">
              Language
              <span className="row-sub">Every notification arrives written in it.</span>
            </span>
            <select className="row-select" value={locale} onChange={(e) => changeLocale(e.target.value)} aria-label="Language">
              {Object.entries(LOCALE_NAMES).map(([code, label]) => (
                <option key={code} value={code}>{label}</option>
              ))}
            </select>
          </div>
        </div>

        <div className="rows-title">Your workspace</div>
        <div className="rows">
          <button className="row" onClick={() => onOpen('history')}>
            <span className="row-icon">↺</span>
            <span className="row-main">History<span className="row-sub">Everything already settled.</span></span>
            <span className="row-value">›</span>
          </button>
          <button className="row" onClick={() => onOpen('record')}>
            <span className="row-icon">▤</span>
            <span className="row-main">The record<span className="row-sub">Every decision, by business, written by nobody.</span></span>
            <span className="row-value">›</span>
          </button>
          <button className="row" onClick={() => onOpen('tools')}>
            <span className="row-icon">⚯</span>
            <span className="row-main">Tools<span className="row-sub">Gmail, Slack, Notion, GitHub.</span></span>
            <span className="row-value">›</span>
          </button>
          <button className="row" onClick={() => onOpen('notifications')}>
            <span className="row-icon">◉</span>
            <span className="row-main">Notifications<span className="row-sub">Where a decision reaches you.</span></span>
            <span className="row-value">›</span>
          </button>
          <button className="row" onClick={() => onOpen('invite')}>
            <span className="row-icon">＋</span>
            <span className="row-main">Invite a teammate<span className="row-sub">They get their own AI, in this workspace.</span></span>
            <span className="row-value">›</span>
          </button>
          <button className="row" onClick={() => onOpen('plans')}>
            <span className="row-icon">◆</span>
            <span className="row-main">Plan<span className="row-sub">What you are on, and what else there is.</span></span>
            <span className="row-value">›</span>
          </button>
        </div>

        {businesses.length > 0 && (
          <>
            <div className="rows-title">Businesses your AI has found</div>
            <div className="chips">
              {businesses.map((b) => <span key={b.slug} className="pill-tag">{b.name}</span>)}
            </div>
            <p className="hint" style={{ margin: '8px 4px 20px', color: 'var(--ash)', fontSize: 12.5 }}>
              Nobody made this list. It grows as decisions are filed.
            </p>
          </>
        )}

        <div className="rows">
          <button className="row" onClick={onLogout}>
            <span className="row-main" style={{ color: 'var(--slate)' }}>Sign out</span>
          </button>
          <button className="row" onClick={() => setConfirmDelete(true)}>
            <span className="row-main" style={{ color: '#a11258' }}>Delete account</span>
          </button>
        </div>

        {confirmDelete && (
          <div className="form-error">
            This removes your account and your cards. Decisions other people
            made stay in their record — those are theirs, not yours.
            <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
              <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>Keep it</button>
              <button className="btn btn-primary" onClick={deleteAccount}>Delete</button>
            </div>
          </div>
        )}
        <div style={{ height: 32 }} />
      </div>
    </div>
  )
}
