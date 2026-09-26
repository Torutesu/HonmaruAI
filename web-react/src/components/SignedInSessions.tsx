import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { ago } from '../utils/ago'
import { Icon } from './Icon'

// Where you are signed in: this browser, your phone, the laptop at the
// office — and signing any of them out, or all the others at once. A lost
// phone is one tap away from being nobody's way in.

export interface SessionRow {
  ref: string; client: string | null; device: string; place: string | null
  app?: 'iphone' | 'ipad' | null; browser?: string | null; os?: string | null
  createdAt: string; lastSeenAt: string; current: boolean
}

export const SignedInSessions: React.FC<{ httpBase: string; sessionToken: string }> = ({ httpBase, sessionToken }) => {
  const t = useT()
  const [sessions, setSessions] = useState<SessionRow[] | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${httpBase}/sessions`, { headers: { 'x-session-token': sessionToken } })
      const data = await res.json().catch(() => ({}))
      if (res.ok) setSessions(data.sessions || [])
    } catch { setSessions([]) }
  }, [httpBase, sessionToken])
  useEffect(() => { void load() }, [load])

  const end = async (body: { ref?: string; others?: boolean }, key: string) => {
    setBusy(key); setError(null)
    try {
      const res = await fetch(`${httpBase}/sessions`, {
        method: 'DELETE', headers: { 'content-type': 'application/json', 'x-session-token': sessionToken }, body: JSON.stringify(body),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not work. Try again in a moment.')); return }
      setSessions(data.sessions || [])
    } finally { setBusy(null) }
  }

  const others = (sessions || []).filter((s) => !s.current)
  return (
    <div className="signed-in" data-sessions="1">
      <div className="rows-title">{t('Where you’re signed in')}</div>
      <div className="rows">
        {sessions === null && <div className="row static"><span className="row-main">{t('Loading…')}</span></div>}
        {(sessions || []).map((s) => (
          <div key={s.ref} className="row static session-row" data-session={s.ref} data-current={s.current ? '1' : undefined}>
            <span className="row-icon"><Icon name={s.client === 'ios' ? 'devices' : 'monitor'} size={18} /></span>
            <span className="row-main">
              {s.app ? t(s.app === 'ipad' ? 'iPad app' : 'iPhone app')
                : s.browser && s.os ? t('{browser} on {os}', { browser: s.browser, os: s.os })
                  : s.browser || s.os || t('Unknown device')}
              <span className="row-sub">
                {s.current ? t('This device') : t('Last used {when}', { when: ago(s.lastSeenAt) })}
                {s.place ? ` · ${s.place}` : ''}
              </span>
            </span>
            {!s.current && (
              <button type="button" className="pill-btn session-end" disabled={busy === s.ref} onClick={() => void end({ ref: s.ref }, s.ref)}>
                {t('Sign out')}
              </button>
            )}
          </div>
        ))}
      </div>
      {others.length > 1 && (
        <button type="button" className="btn-text danger sessions-end-others" disabled={busy === 'others'} onClick={() => void end({ others: true }, 'others')}>
          <Icon name="log-out" size={14} /> {t('Sign out everywhere else')}
        </button>
      )}
      {error && <div className="form-error">{error}</div>}
    </div>
  )
}
