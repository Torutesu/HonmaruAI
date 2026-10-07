import { DesktopNotificationSettings } from './DesktopNotificationSettings'
import React, { useEffect, useState } from 'react'
import { pushSupport, currentSubscription, enableWebPush, prefetchVapidKey, resyncWebPush, type PushSupport } from '../utils/push'
import { useT } from '../utils/i18n'
import { Icon } from './Icon'

interface Props {
  httpBase: string
  sessionToken: string
}

/// One button in the top bar until notifications are on. It asks from a
/// click, because browsers ignore a permission prompt nobody asked for, and
/// on an iPhone it says the true thing: add to the home screen first.
/// Nothing here ever covers the card.
///
/// While it is on screen it also keeps this browser's subscription alive:
/// handed to the Worker again on every open, and again whenever the service
/// worker says the browser replaced it (Firefox does, now and then).
export const NotificationsButton: React.FC<Props> = ({ httpBase, sessionToken }) => {
  const t = useT()
  const [support, setSupport] = useState<PushSupport>('unsupported')
  const [state, setState] = useState<'unknown' | 'off' | 'on' | 'busy' | 'failed'>('unknown')
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    const now = pushSupport()
    setSupport(now)
    // The key the click will need, fetched while nobody is waiting on it.
    if (now === 'ready') void prefetchVapidKey(httpBase)
    // A resync that failed shows the bell again only when this browser really
    // has no subscription any more — not for being offline, or a Worker
    // error, while pushes still arrive. The next open tries again.
    const resync = () => resyncWebPush(httpBase, sessionToken).then(async (ok) => {
      if (cancelled) return
      if (ok) { setState('on'); return }
      if (!(await currentSubscription()) && !cancelled) setState('off')
    })
    currentSubscription().then((sub) => {
      if (cancelled) return
      setState(sub ? 'on' : 'off')
      // Also when there is none: one the browser dropped while push was on
      // here is made again (utils/push.ts keeps the key for that).
      void resync()
    })
    const onWorkerMessage = (event: MessageEvent) => {
      if (event.data?.type === 'push-resync') void resync()
    }
    const sw = typeof navigator !== 'undefined' && 'serviceWorker' in navigator ? navigator.serviceWorker : null
    sw?.addEventListener('message', onWorkerMessage)
    return () => { cancelled = true; sw?.removeEventListener('message', onWorkerMessage) }
  }, [httpBase, sessionToken])

  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 6000)
    return () => clearTimeout(t)
  }, [note])

  if (support === 'desktop') return <DesktopNotificationSettings compact />

  if (state === 'on' || state === 'unknown' || support === 'unsupported') return null

  const click = async () => {
    if (support === 'needs-install') {
      setNote(t('On iPhone: tap Share → Add to Home Screen, then open Honmaru from there to get notified.'))
      return
    }
    if (support === 'denied' || pushSupport() === 'denied') {
      setSupport('denied')
      setNote(t('Notifications are blocked for this site. Allow them in your browser settings.'))
      return
    }
    setState('busy')
    const result = await enableWebPush(httpBase, sessionToken)
    if (result === 'on') { setState('on'); setNote(t('You will be told when a decision is waiting — even with this tab closed.')) }
    else if (result === 'denied') { setSupport('denied'); setState('off'); setNote(t('Notifications are blocked for this site. Allow them in your browser settings.')) }
    // Closed without an answer: nothing is blocked, the bell stays to ask again.
    else if (result === 'dismissed') { setState('off'); setNote(t('Notifications are still off. You can turn them on whenever you like.')) }
    else { setState('failed'); setNote(t('Could not turn notifications on. Try again in a moment.')) }
  }

  return (
    <>
      <button className="notify-bell" onClick={click} disabled={state === 'busy'} title={t('Turn on notifications')} aria-label={t('Turn on notifications')}>
        <Icon name="bell" size={16} />
        <span className="bell-dot" />
      </button>
      {note && <div className="toast note" role="status" onClick={() => setNote(null)}>{note}</div>}
    </>
  )
}
