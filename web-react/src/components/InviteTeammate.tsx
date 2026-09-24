import React, { useState } from 'react'
import { useT } from '../utils/i18n'

interface Props {
  relayHttpUrl: string
  orgId: string
  sessionToken: string
  /// A code was minted. The team screen around this one lists the codes that
  /// are still out, and a new one belongs in that list straight away.
  onMinted?: () => void
}

/// The roles an invite can grant. The label is what the person minting the
/// code reads; the value is what the membership row gets.
const ROLES: Array<{ id: string; label: string }> = [
  { id: 'member', label: 'Member' },
  { id: 'designer', label: 'Designer' },
  { id: 'engineer', label: 'Engineer' },
  { id: 'admin', label: 'Admin' },
  { id: 'triager', label: 'Triager' },
]

/// One link, one role, one thing to hand over. It works for three days.
///
/// The sheet around this already carries the title, so this does not repeat
/// it, and it borrows the same rows, buttons and type as every other screen
/// rather than the hand-written styles it had — an invite is the first thing
/// a new person sees of this product through somebody else.
export const InviteTeammate: React.FC<Props> = ({ relayHttpUrl, orgId, sessionToken, onMinted }) => {
  const t = useT()
  const [code, setCode] = useState<string | null>(null)
  const [link, setLink] = useState<string | null>(null)
  const [role, setRole] = useState('member')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState<'link' | null>(null)
  // By address: the Worker mints a single-use code and mails it as a link.
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [mailError, setMailError] = useState<string | null>(null)

  const handleInvite = async () => {
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${relayHttpUrl}/invites/create`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-session-token': sessionToken,
        },
        body: JSON.stringify({ orgId, role }),
      })
      const data = await res.json()
      if (!res.ok) {
        setError(data.message || t('Could not create invite.'))
        return
      }
      setCode(data.code)
      setLink(typeof data.link === 'string' ? data.link : null)
      onMinted?.()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  const copy = (what: 'link') => {
    if (!link) return
    navigator.clipboard?.writeText(link)
    setCopied(what)
    setTimeout(() => setCopied(null), 1500)
  }

  const share = () => {
    if (!link) return
    const nav = navigator as Navigator & { share?: (data: { title?: string; text?: string; url?: string }) => Promise<void> }
    if (nav.share) nav.share({ title: 'Honmaru AI', text: t('Join my team on Honmaru AI'), url: link }).catch(() => { /* dismissed */ })
    else copy('link')
  }

  const sendByEmail = async () => {
    const to = email.trim()
    if (!to) return
    setSending(true); setMailError(null); setSentTo(null)
    try {
      const res = await fetch(`${relayHttpUrl}/invites/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ orgId, role, email: to }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setMailError(data.message || t('Could not send the invitation.')); return }
      setSentTo(data.to || to)
      setEmail('')
      onMinted?.()
    } catch (err) {
      setMailError(err instanceof Error ? err.message : String(err))
    } finally { setSending(false) }
  }

  if (code) {
    return (
      <div className="invite">
        <p className="sheet-hint">
          {t('Anyone who opens this link within three days joins your workspace as {role}.', {
            role: t(ROLES.find((r) => r.id === role)?.label || role),
          })}
        </p>
        {link && (
          <div className="invite-row">
            <a className="invite-link" href={link} onClick={(e) => e.preventDefault()}>{link}</a>
            <div className="invite-actions">
              <button className="btn btn-primary invite-copy" onClick={() => copy('link')}>
                {copied === 'link' ? t('Copied!') : t('Copy link')}
              </button>
              <button className="btn btn-quiet invite-copy" onClick={share}>{t('Share')}</button>
            </div>
          </div>
        )}
        <button
          className="btn btn-quiet"
          onClick={() => { setCode(null); setLink(null); setError(null) }}
        >
          {t('Create another')}
        </button>
      </div>
    )
  }

  return (
    <div className="invite">
      <div className="row static">
        <span className="row-main">
          {t('Their role')}
          <span className="row-sub">{t('What their AI puts in front of them first.')}</span>
        </span>
        <select
          className="row-select"
          value={role}
          onChange={(e) => setRole(e.target.value)}
          aria-label={t('Their role')}
        >
          {ROLES.map((r) => <option key={r.id} value={r.id}>{t(r.label)}</option>)}
        </select>
      </div>
      <div className="row static invite-mail">
        <span className="row-main">
          {t('Send an invitation by email')}
          <span className="row-sub">{t('They get a link that opens straight into your team.')}</span>
        </span>
        <div className="invite-mail-form">
          <input
            className="invite-email"
            type="email"
            inputMode="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); void sendByEmail() } }}
            placeholder={t('teammate@company.com')}
            aria-label={t('Email')}
          />
          <button className="pill-btn" onClick={sendByEmail} disabled={sending || !email.trim()}>
            {sending ? t('Sending…') : t('Send')}
          </button>
        </div>
      </div>
      {sentTo && <div className="form-note invite-sent">{t('Invitation sent to {email}.', { email: sentTo })}</div>}
      {mailError && <div className="form-error">{mailError}</div>}
      <button className="btn btn-primary" onClick={handleInvite} disabled={busy}>
        {busy ? t('Creating…') : t('Create invite link')}
      </button>
      {error && <div className="form-error">{error}</div>}
    </div>
  )
}
