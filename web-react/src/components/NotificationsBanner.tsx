import React, { useEffect, useState } from 'react'
import { pushSupport, currentSubscription, enableWebPush, type PushSupport } from '../utils/push'

interface Props {
  httpBase: string
  sessionToken: string
}

/// One line at the top of the feed until notifications are on. It asks from a
/// click, because browsers ignore a permission prompt nobody asked for, and it
/// says the true thing on an iPhone: add to the home screen first.
export const NotificationsBanner: React.FC<Props> = ({ httpBase, sessionToken }) => {
  const [support, setSupport] = useState<PushSupport>('unsupported')
  const [state, setState] = useState<'unknown' | 'off' | 'on' | 'busy' | 'failed'>('unknown')

  useEffect(() => {
    let cancelled = false
    setSupport(pushSupport())
    currentSubscription().then((sub) => { if (!cancelled) setState(sub ? 'on' : 'off') })
    return () => { cancelled = true }
  }, [sessionToken])

  if (state === 'on' || state === 'unknown') return null
  if (support === 'unsupported') return null

  const turnOn = async () => {
    setState('busy')
    const result = await enableWebPush(httpBase, sessionToken)
    if (result === 'on') setState('on')
    else if (result === 'denied') { setSupport('denied'); setState('off') }
    else setState('failed')
  }

  return (
    <div className="notify-banner" role="status">
      {support === 'needs-install' && (
        <span>To get notified on this iPhone, tap Share → <strong>Add to Home Screen</strong>, then open Honmaru from there.</span>
      )}
      {support === 'denied' && (
        <span>Notifications are blocked for this site. Allow them in your browser settings to be told when a decision is waiting.</span>
      )}
      {support === 'ready' && (
        <>
          <span>Be told when a decision is waiting on you — even with this tab closed.</span>
          <button className="notify-button" onClick={turnOn} disabled={state === 'busy'}>
            {state === 'busy' ? 'Turning on…' : state === 'failed' ? 'Try again' : 'Turn on notifications'}
          </button>
        </>
      )}
    </div>
  )
}
