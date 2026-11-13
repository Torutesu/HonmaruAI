import React, { useEffect, useRef, useState } from 'react'
import { Dialog } from './Dialog'
import { useT } from '../utils/i18n'
import type { InvitePeek } from '../screens/SignIn'

// A team invite link opened while signed in (#960). Opening the link is not
// the person's consent: anything can open it (an email, a chat message, a web
// page, another program handing the desktop app honmaru://join/…), and
// redeeming it makes them a member of someone else's workspace. So the
// workspace is named first, from the preview that spends nothing, and the
// invite is redeemed only when they press Join. Joining does not move them
// either: they choose whether to open the workspace they joined.
//
// An answer of 202 means the workspace holds outsiders for an admin's
// approval: there is no membership yet, so nothing is opened and the dialog
// says they are waiting.
type Phase =
  | { kind: 'loading' }
  | { kind: 'invalid' }
  | { kind: 'ask'; peek: InvitePeek; joining?: boolean; error?: string }
  | { kind: 'joined'; peek: InvitePeek; orgId: string; already: boolean }
  | { kind: 'held'; peek: InvitePeek }

export function JoinInviteDialog({ httpBase, sessionToken, code, onClose, onOpen }: {
  httpBase: string; sessionToken: string; code: string
  /// Cancelled, dismissed, or done without opening anything.
  onClose: () => void
  /// Open the workspace they just joined.
  onOpen: (orgId: string) => void
}) {
  const t = useT()
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' })
  const joining = useRef(false)
  useEffect(() => {
    const controller = new AbortController()
    setPhase({ kind: 'loading' })
    fetch(`${httpBase}/invites/peek?code=${encodeURIComponent(code)}`, { signal: controller.signal })
      .then(async (response) => {
        const peek = response.ok ? await response.json().catch(() => null) : null
        if (controller.signal.aborted) return
        setPhase(peek && typeof peek === 'object' ? { kind: 'ask', peek: peek as InvitePeek } : { kind: 'invalid' })
      })
      .catch(() => { if (!controller.signal.aborted) setPhase({ kind: 'invalid' }) })
    return () => controller.abort()
  }, [httpBase, code])

  const team = (peek: InvitePeek) => peek.team || t('this workspace')
  const join = async (peek: InvitePeek) => {
    if (joining.current) return
    joining.current = true
    setPhase({ kind: 'ask', peek, joining: true })
    try {
      const response = await fetch(`${httpBase}/invites/accept`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ code }),
      })
      const data = await response.json().catch(() => ({}))
      if (response.status === 202 || data?.pending) setPhase({ kind: 'held', peek })
      else if (response.ok && typeof data?.orgId === 'string') setPhase({ kind: 'joined', peek, orgId: data.orgId, already: data.joined === false })
      else setPhase({ kind: 'ask', peek, error: data?.message || t('That invite code is not valid.') })
    } catch {
      setPhase({ kind: 'ask', peek, error: t('Could not reach the relay.') })
    } finally {
      joining.current = false
    }
  }
  const close = () => { if (!joining.current) onClose() }

  if (phase.kind === 'loading' || phase.kind === 'invalid') {
    return <Dialog title={t('Workspace invitation')} className="join-invite" onClose={close}
      footer={<button type="button" className="dlg-btn" onClick={close}>{t(phase.kind === 'loading' ? 'Cancel' : 'Close')}</button>}>
      {phase.kind === 'loading'
        ? <p role="status">{t('Checking the invitation…')}</p>
        : <p className="dlg-error" role="alert">{t('This invitation is not valid, or has expired.')}</p>}
    </Dialog>
  }
  if (phase.kind === 'held') {
    return <Dialog title={t('Join {team}?', { team: team(phase.peek) })} className="join-invite" onClose={close}
      footer={<button type="button" className="dlg-btn primary" onClick={close}>{t('Close')}</button>}>
      <p role="status">{t('An admin of {team} needs to approve you. You will be let in once they do.', { team: team(phase.peek) })}</p>
    </Dialog>
  }
  if (phase.kind === 'joined') {
    const { orgId } = phase
    return <Dialog title={t('Join {team}?', { team: team(phase.peek) })} className="join-invite" onClose={close}
      footer={<>
        <button type="button" className="dlg-btn" onClick={close}>{t('Stay here')}</button>
        <button type="button" className="dlg-btn primary" onClick={() => onOpen(orgId)}>{t('Open {team}', { team: team(phase.peek) })}</button>
      </>}>
      <p role="status">{phase.already ? t('You already belong to this workspace.') : t('You joined {team}.', { team: team(phase.peek) })}</p>
    </Dialog>
  }
  const { peek } = phase
  return <Dialog title={t('Join {team}?', { team: team(peek) })} className="join-invite" onClose={close}
    footer={<>
      <button type="button" className="dlg-btn" disabled={phase.joining} onClick={close}>{t('Cancel')}</button>
      <button type="button" className="dlg-btn primary" disabled={phase.joining} onClick={() => void join(peek)}>{t(phase.joining ? 'Joining…' : 'Join')}</button>
    </>}>
    {peek.inviter && <p>{t('{inviter} invited you to this workspace.', { inviter: peek.inviter })}</p>}
    <p className="dlg-hint">{t('Joining adds you to this workspace. You stay where you are until you choose to open it.')}</p>
    {phase.error && <p className="dlg-error" role="alert">{phase.error}</p>}
  </Dialog>
}
