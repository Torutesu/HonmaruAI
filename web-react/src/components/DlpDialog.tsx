import React, { useEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { Dialog } from './Dialog'
import type { DlpWarning } from '../utils/authGuard'

/// "This looks like it contains…": asked when one of the workspace's data
/// rules warns about a message (utils/authGuard). Sending anyway sends the
/// same message again, acknowledged; going back leaves it in the composer.
export const DlpDialog: React.FC = () => {
  const t = useT()
  const [ask, setAsk] = useState<DlpWarning | null>(null)
  const pending = useRef<DlpWarning | null>(null)
  useEffect(() => {
    const on = (e: Event) => {
      const detail = (e as CustomEvent<DlpWarning>).detail
      e.preventDefault()
      if (!detail.current() || pending.current) { detail.resolve(false); return }
      pending.current=detail
      setAsk(detail)
    }
    const onStorage = () => {
      if (pending.current && !pending.current.current()) {
        pending.current.resolve(false); pending.current=null; setAsk(null)
      }
    }
    window.addEventListener('honmaru:dlp-warning', on)
    window.addEventListener('storage',onStorage)
    return () => {
      window.removeEventListener('honmaru:dlp-warning', on)
      window.removeEventListener('storage',onStorage)
      pending.current?.resolve(false); pending.current=null
    }
  }, [])
  if (!ask) return null
  const finish = (send: boolean) => { pending.current=null; ask.resolve(send && ask.current()); setAsk(null) }
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
      {ask.files?.length ? <p className="dlg-note" data-dlp-files>{t('Found in: {files}', { files: ask.files.join(', ') })}</p> : null}
      <p className="dlg-note">{t('If you send it, the audit log notes that a rule warned you — not what you wrote.')}</p>
    </Dialog>
  )
}
