import React, { useEffect, useState } from 'react'
import { desktopApp } from '../utils/desktop'
import { DESKTOP_NOTIFICATION_CHANGE, desktopNotificationsEnabled, enableDesktopNotifications, setDesktopNotificationsEnabled, testDesktopNotification } from '../utils/desktopNotifications'
import { useT } from '../utils/i18n'

export function DesktopNotificationSettings({ compact = false }: { compact?: boolean }) {
  const t = useT()
  const [enabled, setEnabled] = useState(desktopNotificationsEnabled)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState('')
  const [denied, setDenied] = useState(() => typeof Notification !== 'undefined' && Notification.permission === 'denied')
  useEffect(() => {
    const refresh = () => { setEnabled(desktopNotificationsEnabled()); setDenied(typeof Notification !== 'undefined' && Notification.permission === 'denied') }
    window.addEventListener(DESKTOP_NOTIFICATION_CHANGE, refresh)
    window.addEventListener('focus', refresh)
    return () => { window.removeEventListener(DESKTOP_NOTIFICATION_CHANGE, refresh); window.removeEventListener('focus', refresh) }
  }, [])
  const toggle = async () => {
    if (busy) return
    setBusy(true); setNote('')
    try {
      if (enabled) setDesktopNotificationsEnabled(false)
      else if (!(await enableDesktopNotifications())) setNote('Allow Honmaru AI in your Mac notification settings, then try again.')
      setEnabled(desktopNotificationsEnabled())
      setDenied(Notification.permission === 'denied')
    } catch { setNote('Could not turn notifications on. Try again in a moment.') }
    finally { setBusy(false) }
  }
  if (compact && enabled && !denied) return null
  return <div className={compact ? 'desktop-notification-prompt' : 'desktop-notification-settings'}>
    {compact ? <button className="pill-btn" onClick={toggle} disabled={busy}>{t('Turn on notifications')}</button> : <>
      <div className="row static">
        <span className="row-main">{t('Desktop notifications')}<span className="row-sub">{t(denied ? 'Allow Honmaru AI in your Mac notification settings, then try again.' : enabled ? 'On in Honmaru. Your operating system must also allow notifications.' : 'Off. Turn on notifications for new requests and replies.')}</span></span>
        <button className="switch" role="switch" aria-checked={enabled && !denied} aria-label={t('Desktop notifications')} disabled={busy} onClick={toggle} />
      </div>
      <p className="lede" style={{fontSize:14}}>{t('Notifications arrive while Honmaru is running, including with its window closed. Quitting the app stops them.')}</p>
      <button className="pill-btn" disabled={!enabled || denied} onClick={() => {
        try { testDesktopNotification(); setNote('Test requested. If nothing appears, allow Honmaru AI in system notification settings and check Focus mode.') }
        catch { setNote('Could not turn notifications on. Try again in a moment.') }
      }}>{t('Send a test notification')}</button>
      {desktopApp()?.openNotificationSettings && <button className="pill-btn" onClick={() => desktopApp()?.openNotificationSettings?.()}>{t('Open system notification settings')}</button>}
    </>}
    {note && <p className="desktop-notification-note" role="status">{t(note)}</p>}
  </div>
}
