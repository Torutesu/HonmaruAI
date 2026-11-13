import React from 'react'
import { Dialog } from './Dialog'
import { useT } from '../utils/i18n'

// A guest invitation to someone else's Thread, App or File, opened while
// signed in. As with team invite links (#960), opening the link is not the
// person agreeing to it: any page can open it, and accepting shows the
// sharing workspace their name and account. So it is redeemed only when they
// press Accept. There is no preview for these links, so the dialog says what
// accepting does rather than whose workspace it is.
export function ExternalInviteDialog({ busy, onAccept, onCancel }: { busy: boolean; onAccept: () => void; onCancel: () => void }) {
  const t = useT()
  return <Dialog title={t('Accept this invitation?')} className="external-invite" onClose={() => { if (!busy) onCancel() }}
    footer={<>
      <button type="button" className="dlg-btn" disabled={busy} onClick={onCancel}>{t('Cancel')}</button>
      <button type="button" className="dlg-btn primary" disabled={busy} onClick={onAccept}>{t('Accept')}</button>
    </>}>
    <p>{t('Someone outside your workspace shared a Thread, App or File with you. Accepting gives you guest access to it and shows the workspace that shared it your name and account.')}</p>
  </Dialog>
}
