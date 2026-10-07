import React, { useEffect, useRef, useState } from 'react'
import { SoundChoice } from './SoundChoice'
import { Icon } from './Icon'
import { useT } from '../utils/i18n'
import { desktopApp } from '../utils/desktop'
import { desktopNotificationsEnabled, enableDesktopNotifications, testDesktopNotification } from '../utils/desktopNotifications'
import { enableWebPush, prefetchVapidKey, pushSupport, type EnableResult } from '../utils/push'

// Permission is asked only from the person's click. Provider/browser permission
// and a notification actually seen are deliberately separate states.
export function OnboardingNotifications({ httpBase, sessionToken, busy, error, onBack, onDone }: {
  httpBase: string; sessionToken: string; busy: boolean; error: string | null; onBack: () => void; onDone: () => void
}) {
  const t = useT()
  const desktop = !!desktopApp()
  const [support, setSupport] = useState(pushSupport)
  const [enabled, setEnabled] = useState(() => desktop && desktopNotificationsEnabled() && typeof Notification !== 'undefined' && Notification.permission === 'granted')
  const [asking, setAsking] = useState(false)
  const [result, setResult] = useState<EnableResult | null>(null)
  const [tested, setTested] = useState(false)
  const [seen, setSeen] = useState(false)
  const [help, setHelp] = useState(false)
  const alive = useRef(true)
  useEffect(() => {
    alive.current = true
    if (!desktop && support === 'ready') void prefetchVapidKey(httpBase)
    const refresh = () => {
      setSupport(pushSupport())
      setResult(null)
      if (desktop) setEnabled(desktopNotificationsEnabled() && typeof Notification !== 'undefined' && Notification.permission === 'granted')
    }
    window.addEventListener('focus', refresh)
    return () => { alive.current = false; window.removeEventListener('focus', refresh) }
  }, [desktop, httpBase, support])
  const enable = async () => {
    if (asking || busy) return
    setAsking(true); setResult(null)
    try {
      const answer = desktop ? (await enableDesktopNotifications() ? 'on' : typeof Notification !== 'undefined' && Notification.permission === 'denied' ? 'denied' : 'dismissed') : await enableWebPush(httpBase, sessionToken)
      if (alive.current) { setResult(answer); setEnabled(answer === 'on'); setHelp(answer === 'denied') }
    } catch { if (alive.current) setResult('unavailable') }
    finally { if (alive.current) setAsking(false) }
  }
  const test = () => {
    try { testDesktopNotification(); setTested(true); setSeen(false); setHelp(false) }
    catch { setHelp(true); setResult('unavailable') }
  }
  const unavailable = support === 'unsupported' || support === 'needs-install'
  const blocked = support === 'denied' || result === 'denied'
  return <div className="screen ob-setup ob-notifications" data-onboarding="notifications">
    <div className="screen-head">
      <button className="back" disabled={busy || asking} onClick={onBack} aria-label={t('Back')}>‹</button>
      <span className="head-title">{t('Notifications')}</span>
      <span className="spacer" /><span className="ob-step">{t('Last step')}</span>
    </div>
    <div className="screen-body">
      <div className="ob-notification-icon" aria-hidden="true"><Icon name="bell" size={32} /></div>
      <h1 className="display">{t('Do not miss a request or reply.')}</h1>
      <p className="lede">{t('Know when someone needs your decision, replies to your request, or mentions you. You can pause notifications whenever you need to focus.')}</p>
      <div className="ob-permission-card">
        <h2>{t(desktop ? 'Set up this Mac' : 'Set up this browser')}</h2>
        <p>{t(desktop ? 'Turn notifications on here, then allow Honmaru AI in your Mac notification settings.' : 'Choose Allow when your browser asks. Notification settings are saved for this device.')}</p>
        {enabled ? <p className="ob-notification-status" role="status"><Icon name="check" size={18} />{t(seen ? 'Test notification confirmed.' : desktop ? 'On in Honmaru. Check that your Mac can display it.' : 'This browser is registered for notifications.')}</p> : !unavailable && !blocked && <button className="btn btn-primary" disabled={asking || busy} onClick={enable}>{t(asking ? 'Waiting for permission…' : 'Turn on notifications')}</button>}
        {desktop && enabled && <button className="pill-btn" disabled={busy || asking} onClick={test}>{t('Send a test notification')}</button>}
        {tested && !seen && <div className="ob-confirm" role="group" aria-label={t('Did the notification appear?')}>
          <p>{t('Did the notification appear?')}</p>
          <button className="pill-btn" onClick={() => { setSeen(true); setHelp(false) }}>{t('Yes, I saw it')}</button>
          <button className="pill-btn" onClick={() => setHelp(true)}>{t('Nothing appeared')}</button>
        </div>}
        {(help || blocked || result === 'unavailable' || result === 'dismissed' || unavailable) && <div className="ob-notification-help" role="status">
          <p>{t(support === 'needs-install' ? 'On iPhone or iPad, add Honmaru to your Home Screen first. You can finish setup now and turn on notifications later.' : support === 'unsupported' ? 'Notifications are not available in this browser. You can keep using Honmaru and set them up on another device.' : desktop ? 'In System Settings → Notifications → Honmaru AI, allow notifications. Also check Focus mode. Then send another test.' : blocked ? 'Notifications are blocked for this site. Allow them in your browser settings, then return here.' : result === 'dismissed' ? 'No choice was made. Try again or set this up later.' : 'We could not finish notification setup. Try again or set this up later.')}</p>
        </div>}
        {desktop && desktopApp()?.openNotificationSettings && <button className="pill-btn" onClick={() => desktopApp()?.openNotificationSettings?.()}>{t('Open system notification settings')}</button>}
      </div>
      <p className="hint">{t('You can change this later in You → Notifications. Saying no will not stop you using Honmaru.')}</p>
      {desktop && <p className="hint">{t('Notifications arrive while Honmaru is running, including with its window closed. Quitting the app stops them.')}</p>}
      <SoundChoice />
    </div>
    <div className="screen-foot bare">
      {error && <div className="form-error" role="alert">{error}</div>}
      <p className="hint">{t('Next: open your workspace and send your first request.')}</p>
      <button className="btn btn-primary" disabled={busy || asking} onClick={onDone}>{t(busy ? 'Saving…' : enabled ? 'Open my feed' : 'Set up later and continue')}</button>
    </div>
  </div>
}
