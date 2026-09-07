import React, { useEffect, useState } from 'react'
import { InviteTeammate } from './InviteTeammate'
import { getLocale, setLocale, SUPPORTED, primary } from '../utils/locale'
import { syncLocale } from '../utils/push'
import type { Business } from '../types/card'

interface Props {
  httpBase: string
  orgId: string
  userId: string
  sessionToken: string
  businesses: Business[]
  onOpenRecord: () => void
  onLogout: () => void
  onClose: () => void
  onLocaleChange: () => void
}

interface Me { locale: string; email: string | null; emailEditable: boolean; notifyEmail: boolean }

/// You: the language you read in, where email falls back to, the team, the
/// businesses your AI has filed things under, and the way out.
export const YouSheet: React.FC<Props> = ({ httpBase, orgId, userId, sessionToken, businesses, onOpenRecord, onLogout, onClose, onLocaleChange }) => {
  const [me, setMe] = useState<Me | null>(null)
  const [locale, setLocaleState] = useState<string>(() => { try { return localStorage.getItem('locale') || '' } catch { return '' } })
  const [email, setEmail] = useState('')
  const [saved, setSaved] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const auth = { 'content-type': 'application/json', 'x-session-token': sessionToken }

  useEffect(() => {
    fetch(`${httpBase}/me`, { headers: auth }).then(async (r) => {
      if (!r.ok) return
      const data = await r.json()
      setMe(data)
      setEmail(data.email || '')
    }).catch(() => {})
  }, [httpBase, sessionToken])

  const changeLocale = async (value: string) => {
    setLocaleState(value)
    setLocale(value || null)
    await syncLocale(httpBase, sessionToken, value || getLocale())
    onLocaleChange()
  }

  const saveEmail = async () => {
    setError(null)
    const res = await fetch(`${httpBase}/me`, { method: 'PUT', headers: auth, body: JSON.stringify({ email }) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data.message || 'Could not save.'); return }
    setMe((m) => m ? { ...m, email: data.email } : m)
    setSaved('Saved'); setTimeout(() => setSaved(null), 2000)
  }

  const toggleEmail = async () => {
    if (!me) return
    const next = !me.notifyEmail
    setMe({ ...me, notifyEmail: next })
    await fetch(`${httpBase}/me`, { method: 'PUT', headers: auth, body: JSON.stringify({ notifyEmail: next }) }).catch(() => {})
  }

  return (
    <aside className="sheet sheet-side" role="dialog" aria-label="You">
      <div className="sheet-title">You <button className="close" onClick={onClose} aria-label="Close">×</button></div>
      <p className="sheet-hint">{userId} · {orgId}</p>

      <button className="record-button" onClick={onOpenRecord}>
        <span>The record</span><small>Every decision, per business</small>
      </button>

      <div className="sheet-subtitle">Language</div>
      <p className="sheet-hint">Cards and every notification — here, on your phone, by email — are written in it.</p>
      <select className="you-select" value={locale} onChange={(e) => changeLocale(e.target.value)} aria-label="Language">
        <option value="">Browser ({primary(navigator.language)})</option>
        {SUPPORTED.map((code) => <option key={code} value={code}>{code === 'ja' ? '日本語' : 'English'}</option>)}
      </select>

      {me && (
        <>
          <div className="sheet-subtitle">Email</div>
          <p className="sheet-hint">Where a decision goes when no device or browser of yours can be reached.</p>
          {me.emailEditable ? (
            <form className="you-row" onSubmit={(e) => { e.preventDefault(); saveEmail() }}>
              <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} placeholder="you@example.com" aria-label="Email" />
              <button type="submit" className="ghost">{saved || 'Save'}</button>
            </form>
          ) : (
            <p className="sheet-hint">{me.email}</p>
          )}
          {error && <div className="create-error">{error}</div>}
          {me.email && (
            <label className="you-toggle">
              <input type="checkbox" checked={me.notifyEmail} onChange={toggleEmail} /> Email me when nothing else reaches me
            </label>
          )}
        </>
      )}

      <div className="sheet-subtitle">Team</div>
      <InviteTeammate relayHttpUrl={httpBase} orgId={orgId} sessionToken={sessionToken} />

      {businesses.length > 0 && (
        <>
          <div className="sheet-subtitle">Businesses your AI has filed decisions under</div>
          <div className="business-list">{businesses.map((b) => <span key={b.slug} className="business-tag">{b.name}</span>)}</div>
        </>
      )}

      <div className="shortcuts">
        <div className="sheet-subtitle">Keys</div>
        <span>↑ ↓ next card</span><span>A approve</span><span>D decline</span><span>R reply</span><span>N tell your AI</span><span>Esc close</span>
      </div>
      <button className="logout-button" onClick={onLogout}>Log out</button>
    </aside>
  )
}
