import React, { useEffect, useState } from 'react'
import { pushSupport, currentSubscription, enableWebPush, type PushSupport } from '../utils/push'
import { useT } from '../utils/i18n'

interface Props {
  httpBase: string
  sessionToken: string
}

/// One button in the top bar until notifications are on. It asks from a
/// click, because browsers ignore a permission prompt nobody asked for, and
/// on an iPhone it says the true thing: add to the home screen first.
/// Nothing here ever covers the card.
export const NotificationsButton: React.FC<Props> = ({ httpBase, sessionToken }) => {
  const t = useT()
  const [support, setSupport] = useState<PushSupport>('unsupported')
  const [state, setState] = useState<'unknown' | 'off' | 'on' | 'busy' | 'failed'>('unknown')
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setSupport(pushSupport())
    currentSubscription().then((sub) => { if (!cancelled) setState(sub ? 'on' : 'off') })
    return () => { cancelled = true }
  }, [sessionToken])

  useEffect(() => {
    if (!note) return
    const t = setTimeout(() => setNote(null), 6000)
    return () => clearTimeout(t)
  }, [note])

  if (state === 'on' || state === 'unknown' || support === 'unsupported') return null

  const click = async () => {
    if (support === 'needs-install') {
      setNote('On iPhone: tap Share → Add to Home Screen, then open Honmaru from there to get notified.')
      return
    }
    if (support === 'denied') {
      setNote('Notifications are blocked for this site. Allow them in your browser settings.')
      return
    }
    setState('busy')
    const result = await enableWebPush(httpBase, sessionToken)
    if (result === 'on') { setState('on'); setNote('You will be told when a decision is waiting — even with this tab closed.') }
    else if (result === 'denied') { setSupport('denied'); setState('off') }
    else { setState('failed'); setNote(t('Could not turn notifications on. Try again in a moment.')) }
  }

  return (
    <>
      <button className="notify-bell" onClick={click} disabled={state === 'busy'} title={t('Turn on notifications')} aria-label={t('Turn on notifications')}>
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9" /><path d="M13.7 21a2 2 0 0 1-3.4 0" />
        </svg>
        <span className="bell-dot" />
      </button>
      {note && <div className="toast note" onClick={() => setNote(null)}>{note}</div>}
    </>
  )
}
