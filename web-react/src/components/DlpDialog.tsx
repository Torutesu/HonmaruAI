import React, { useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { Dialog } from './Dialog'
import type { DlpWarning } from '../utils/authGuard'

/// "This looks like it contains…": asked when one of the workspace's data
/// rules warns about a message (utils/authGuard). Sending anyway sends the
/// same message again, acknowledged; going back leaves it in the composer.
export const DlpDialog: React.FC = () => {
  const t = useT()
  const [ask, setAsk] = useState<DlpWarning | null>(null)
  useEffect(() => {
    const on = (e: Event) => {
      const detail = (e as CustomEvent<DlpWarning>).detail
      e.preventDefault()
      setAsk((current) => {
        if (current) { detail.resolve(false); return current }
        return detail
      })
    }
    window.addEventListener('honmaru:dlp-warning', on)
    return () => window.removeEventListener('honmaru:dlp-warning', on)
  }, [])
  if (!ask) return null
  const finish = (send: boolean) => { ask.resolve(send); setAsk(null) }
  return (
    <Dialog
      title={t('Send this?')}
      lede={t('It looks like it contains {what}. Your workspace asks you to check before sending that here.', { what: ask.rules.map((r) => t(r)).join(', ') })}
      onClose={() => finish(false)}
      footer={(
        <>
          <button className="dlg-btn" data-dlp-back onClick={() => finish(false)}>{t('Go back and edit')}</button>
          <button className="dlg-btn primary" data-dlp-send onClick={() => finish(true)}>{t('Send anyway')}</button>
        </>
      )}
    >
      <p className="dlg-note">{t('If you send it, the audit log notes that a rule warned you — not what you wrote.')}</p>
    </Dialog>
  )
}
