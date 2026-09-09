import React, { useEffect, useState } from 'react'
import { enableWebPush, disableWebPush, pushSupport, currentSubscription } from '../utils/push'
import { useT } from '../utils/i18n'
import { Icon } from '../components/Icon'

interface Props {
  httpBase: string
  sessionToken: string
  onClose: () => void
}

interface Me {
  email: string | null
  emailEditable: boolean
  notifyEmail: boolean
  locale: string
}

/// Where a decision reaches you when the app is not open.
///
/// Three channels, one rule: email is the floor, and it only carries a
/// decision when no push channel could. Saying that on the screen is the
/// difference between "why am I getting email?" and "of course I am".
export const NotificationSettings: React.FC<Props> = ({ httpBase, sessionToken, onClose }) => {
  const t = useT()
  const [me, setMe] = useState<Me | null>(null)
  const [pushOn, setPushOn] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [email, setEmail] = useState('')
  const support = pushSupport()

  useEffect(() => {
    fetch(`${httpBase}/me`, { headers: { 'x-session-token': sessionToken } })
      .then((r) => r.json())
      .then((data) => { setMe(data); setEmail(data.email || '') })
      .catch(() => setError(t('Could not read your settings.')))
    currentSubscription().then((sub) => setPushOn(Boolean(sub)))
  }, [httpBase, sessionToken])

  const togglePush = async () => {
    setBusy(true); setError(null)
    try {
      if (pushOn) {
        await disableWebPush(httpBase, sessionToken)
        setPushOn(false)
      } else {
        const result = await enableWebPush(httpBase, sessionToken)
        if (result === 'denied') { setError('Your browser refused. Allow notifications for this site, then try again.'); return }
        if (result === 'unavailable') { setError(t('This browser cannot receive push notifications here.')); return }
        setPushOn(true)
      }
    } finally { setBusy(false) }
  }

  const patch = async (body: Record<string, unknown>) => {
    setError(null)
    const res = await fetch(`${httpBase}/me`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
      body: JSON.stringify(body),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(data.message || t('That did not save.')); return false }
    setMe((prev) => (prev ? { ...prev, ...data } : prev))
    return true
  }

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="back" onClick={onClose} aria-label={t('Close')}>‹</button>
        <span className="head-title">{t('Notifications')}</span>
      </div>
      <div className="screen-body">
        {error && <div className="form-error">{error}</div>}

        <div className="rows-title">{t('On this device')}</div>
        <div className="rows">
          <div className="row static">
            <span className="row-icon"><Icon name="bell" size={18} /></span>
            <span className="row-main">
              {t('Push notifications')}
              <span className="row-sub">
                {support === 'needs-install'
                  ? t('On iPhone, add this to your home screen first — Safari only allows notifications for an installed web app.')
                  : support === 'unsupported'
                    ? t('This browser cannot receive them.')
                    : support === 'denied'
                      ? t('Blocked in your browser settings — allow notifications for this site to turn it on.')
                      : t('A decision that needs you arrives even when this tab is closed.')}
              </span>
            </span>
            <button
              className="switch"
              role="switch"
              aria-checked={pushOn}
              aria-label={t('Push notifications')}
              disabled={busy || support !== 'ready'}
              onClick={togglePush}
            />
          </div>
        </div>

        <div className="rows-title">{t('By email')}</div>
        <div className="rows">
          <div className="row static">
            <span className="row-icon"><Icon name="mail" size={18} /></span>
            <span className="row-main">
              {t('Email as the fallback')}
              <span className="row-sub">{t('Only when no device of yours can be reached. Never a duplicate.')}</span>
            </span>
            <button
              className="switch"
              role="switch"
              aria-checked={Boolean(me?.notifyEmail)}
              aria-label={t('Email fallback')}
              disabled={!me}
              onClick={() => patch({ notifyEmail: !me?.notifyEmail })}
            />
          </div>
        </div>

        {me && (
          <div className="field">
            <label htmlFor="notify-email">{t('Where it goes')}</label>
            <input
              id="notify-email"
              type="email"
              value={email}
              disabled={!me.emailEditable}
              onChange={(e) => setEmail(e.target.value)}
              onBlur={() => { if (me.emailEditable && email !== (me.email || '')) patch({ email }) }}
              placeholder={t('you@company.com')}
            />
            <div className="hint">
              {me.emailEditable
                ? t('Changing this changes nothing else — it is only where mail lands.')
                : t('This is the address you sign in with, so it cannot be changed here.')}
            </div>
          </div>
        )}

        <p className="lede" style={{ fontSize: 13.5, marginTop: 20 }}>
          {t('notify.language')}
        </p>
        <div style={{ height: 24 }} />
      </div>
    </div>
  )
}
