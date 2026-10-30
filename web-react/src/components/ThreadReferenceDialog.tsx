import React from 'react'
import type { ChannelMessage } from '../types/card'
import { useT } from '../utils/i18n'
import { Dialog } from './Dialog'
import { MessageFiles } from './Attachments'

export function ThreadReferenceDialog({ message, failed, base, name, at, onClose, children }: {
  message?: ChannelMessage
  failed?: boolean
  base: string
  name: string
  at: string
  onClose: () => void
  children?: React.ReactNode
}) {
  const t = useT()
  return <Dialog title={t('Original message')} onClose={onClose}>
    {failed || message?.deleted ? <p role="alert">{t('That message is not somewhere you can read.')}</p>
      : message ? <><p><b>{name}</b> · {at}</p><div className="slk-text">{children}</div><MessageFiles files={message.files} base={base} /></>
      : <p role="status">{t('Loading…')}</p>}
  </Dialog>
}
