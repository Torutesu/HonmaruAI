import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon, type IconName } from '../components/Icon'

interface Connector { id: string; label: string; status: string }

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
  onClose: () => void
}

// English keys, translated where they are read — see utils/i18n.
const BLURB: Record<string, string> = {
  googlecalendar: 'Meetings still waiting on an answer from you.',
  googledrive: 'Documents someone put in front of you.',
  gmail: 'Mail that needs a decision becomes a card. Nothing else does.',
  slack: 'Messages addressed to you, triaged into decisions — without you opening Slack.',
  notion: 'Decisions are written back to the database you point at.',
  github: 'Approvals, tasks and assignee changes sync to Issues and Pull Requests.',
}
const ICON: Record<string, IconName> = {
  gmail: 'mail', slack: 'hash', notion: 'notion', github: 'github',
  googlecalendar: 'calendar', googledrive: 'drive',
}

/// Your tools, connected — and deliberately not as channels.
///
/// Every connector here is an *input*: it produces decisions in the feed. None
/// of them puts a Slack channel or a Notion sidebar inside this app, because
/// the point of the product is that you stopped going to those places.
export const Tools: React.FC<Props> = ({ httpBase, orgId, sessionToken, onClose }) => {
  const t = useT()
  const [connectors, setConnectors] = useState<Connector[] | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  // Whether the GitHub sync this row advertises can run in *this* workspace.
  // It used to be printed as "Built in" for everyone, and for an email account
  // in the workspace it was given at sign-up it is not built into anything:
  // there is no repository to open an issue in and no token to write with.
  const [github, setGithub] = useState<{ builtIn: boolean; reason: string | null } | null>(null)
  // The address that turns an email into a card. The Worker has answered with
  // it since inbound mail was built, and nothing has ever shown it to anyone —
  // so the connector existed and there was no way to use it.
  const [inbox, setInbox] = useState<string | null>(null)
  const [copiedInbox, setCopiedInbox] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${httpBase}/connectors`, { headers: { 'x-session-token': sessionToken } })
      if (res.status === 503) {
        setUnavailable(t('Connectors are not switched on for this workspace yet.'))
        setConnectors([])
        return
      }
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('Could not load your tools.')); setConnectors([]); return }
      setConnectors(data.connectors || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setConnectors([])
    }
  }, [httpBase, sessionToken])
  useEffect(() => { load() }, [load])

  useEffect(() => {
    let ignore = false
    // 503 is this deployment having no inbound domain configured, which is not
    // an error to show — there is simply nothing to hand out.
    fetch(`${httpBase}/connectors/email/address`, { headers: { 'x-session-token': sessionToken } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!ignore && data?.address) setInbox(data.address) })
      .catch(() => { /* the row simply does not appear */ })
    return () => { ignore = true }
  }, [httpBase, sessionToken])

  useEffect(() => {
    let ignore = false
    fetch(`${httpBase}/connectors/github?orgId=${encodeURIComponent(orgId)}`, {
      headers: { 'x-session-token': sessionToken },
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!ignore && data) setGithub(data) })
      .catch(() => { /* the row simply says nothing until it knows */ })
    return () => { ignore = true }
  }, [httpBase, orgId, sessionToken])

  // The window is opened before the await, not after: a popup opened from a
  // resolved promise is not a user gesture any more, and every browser blocks it.
  const connect = async (id: string) => {
    setBusy(id); setError(null)
    const tab = window.open('', '_blank')
    try {
      const res = await fetch(`${httpBase}/connectors/${id}/connect`, {
        method: 'POST',
        headers: { 'x-session-token': sessionToken },
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.redirectUrl) {
        tab?.close()
        setError(data.message || t('Could not start that connection.'))
        return
      }
      if (tab) tab.location.href = data.redirectUrl
      else window.location.href = data.redirectUrl
      setNote(t('Finish in the tab that opened, then come back and pull.'))
    } catch (err) {
      tab?.close()
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(null) }
  }

  const pull = async () => {
    setSyncing(true); setError(null); setNote(null)
    try {
      const res = await fetch(`${httpBase}/connectors/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ orgId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('Nothing could be pulled just now.')); return }
      // One entry per connector, each with what it scanned and what it made.
      const results: Array<{ created?: number; error?: string }> = data.results || []
      const made = results.reduce((sum, r) => sum + Number(r.created || 0), 0)
      const failed = results.filter((r) => r.error)
      if (failed.length) setError(failed.map((r) => r.error).join(' · '))
      setNote(made > 0 ? t('{n} new in your feed.', { n: made }) : t('Nothing new needed you.'))
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setSyncing(false) }
  }

  const active = (connectors || []).filter((c) => c.status === 'active')

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="back" onClick={onClose} aria-label={t('Close')}>‹</button>
        <span className="head-title">{t('Tools')}</span>
      </div>
      <div className="screen-body">
        <p className="lede" style={{ marginTop: 8 }}>
          {t('tools.lede')}
        </p>

        {unavailable && <div className="form-note">{unavailable}</div>}
        {note && <div className="form-note">{note}</div>}
        {error && <div className="form-error">{error}</div>}

        {connectors === null && <div className="empty">{t('Loading…')}</div>}

        {connectors !== null && connectors.length > 0 && (
          <div className="rows">
            {connectors.map((c) => (
              <div key={c.id} className="row static">
                <span className="row-icon"><Icon name={ICON[c.id] || 'box'} size={18} /></span>
                <span className="row-main">
                  {c.label}
                  <span className="row-sub">{t(BLURB[c.id] || 'Feeds decisions into your feed.')}</span>
                </span>
                {c.status === 'active'
                  ? <span className="pill-tag mint">{t('Connected')}</span>
                  : (
                    <button className="pill-btn" onClick={() => connect(c.id)} disabled={busy === c.id}>
                      {busy === c.id ? '…' : t('Connect')}
                    </button>
                  )}
              </div>
            ))}
          </div>
        )}

        {connectors !== null && connectors.length === 0 && !unavailable && (
          <div className="empty">{t('No connectors are available on this deployment.')}</div>
        )}

        {active.length > 0 && (
          <button className="btn btn-ghost" onClick={pull} disabled={syncing}>
            {syncing ? t('Pulling…') : t('Pull now')}
          </button>
        )}

        {inbox && (
          <>
            <div className="rows-title">{t('Forward anything here')}</div>
            <div className="rows">
              <div className="row static" data-inbox="1">
                <span className="row-icon"><Icon name="mail" size={18} /></span>
                <span className="row-main">
                  <code className="invite-code sm">{inbox}</code>
                  <span className="row-sub">{t('Mail sent here becomes a card, triaged the way your inbox is.')}</span>
                </span>
                <button
                  className="pill-btn"
                  onClick={() => {
                    navigator.clipboard?.writeText(inbox)
                    setCopiedInbox(true)
                    setTimeout(() => setCopiedInbox(false), 1500)
                  }}
                >
                  {copiedInbox ? t('Copied!') : t('Copy')}
                </button>
              </div>
            </div>
          </>
        )}

        {github && (
          <>
            <div className="rows-title">{github.builtIn ? t('Always on') : t('Not in this workspace')}</div>
            <div className="rows">
              <div className="row static" data-github={github.builtIn ? 'on' : 'off'}>
                <span className="row-icon"><Icon name="github" size={18} /></span>
                <span className="row-main">
                  GitHub
                  <span className="row-sub">{github.builtIn ? t(BLURB.github) : t(github.reason || '')}</span>
                </span>
                {github.builtIn
                  ? <span className="pill-tag mint">{t('Built in')}</span>
                  : <span className="pill-tag quiet">{t('Off')}</span>}
              </div>
            </div>
          </>
        )}
        <div style={{ height: 24 }} />
      </div>
    </div>
  )
}
