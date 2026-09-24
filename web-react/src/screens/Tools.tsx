import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon, type IconName } from '../components/Icon'
import { BrandLogo, isBrand } from '../components/BrandLogo'
import { getAIKey } from '../utils/aiKey'
import { ago } from '../utils/ago'

interface Connector { id: string; label: string; status: string }

/// GitHub for this workspace: built in (a repository workspace, synced as
/// your own account from the phone), connected (the workspace names a
/// repository and writes the issues itself), or neither — and whether you
/// may change that, with your own GitHub sign-in or a token.
interface GitHubStatus {
  builtIn: boolean
  connected: boolean
  repo: string | null
  via: 'account' | 'token' | null
  canEdit: boolean
  /// This person's own GitHub is connected (through the OAuth journey or a
  /// GitHub sign-in), so they can pick a repository with no token.
  mine: boolean
  /// The OAuth journey is offered on this deployment.
  oauth: boolean
  reason: string | null
}

/// What this workspace runs its AI on, from the Worker: the model and where
/// each piece comes from. Keys never come back — only whether one is set.
interface AIStatus {
  canEdit: boolean
  model: string | null
  modelSource: 'workspace' | 'deployment' | 'none'
  openai: 'workspace' | 'deployment' | 'none'
  openaiHint: string | null
  systemOne: boolean
  jev: 'workspace' | 'deployment' | 'none'
  jevHint: string | null
  models: Array<{ id: string; priceIn: number; priceOut: number }>
}

/// A personal token an agent uses to reach this workspace over MCP. The
/// secret itself is shown once, when it is made; after that only its first
/// characters, so a person can tell two apart.
interface AgentToken { id: string; name: string; prefix: string; createdAt: string; lastUsedAt: string | null }

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
  const [github, setGithub] = useState<GitHubStatus | null>(null)
  const [ghRepo, setGhRepo] = useState('')
  const [ghToken, setGhToken] = useState('')
  const [ghBusy, setGhBusy] = useState(false)
  const [ghError, setGhError] = useState<string | null>(null)
  const [ghOpen, setGhOpen] = useState(false)
  const [ghRepos, setGhRepos] = useState<Array<{ repo: string; url: string; private: boolean }> | null>(null)
  const [ghUseToken, setGhUseToken] = useState(false)
  const [ghWaiting, setGhWaiting] = useState(false)
  const loadGithubStatus = useCallback(async (): Promise<GitHubStatus | null> => {
    try {
      const res = await fetch(`${httpBase}/connectors/github?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      if (!res.ok) return null
      const data = await res.json() as GitHubStatus
      setGithub(data)
      return data
    } catch { return null }
  }, [httpBase, orgId, sessionToken])
  const loadGithubRepos = useCallback(async () => {
    try {
      const res = await fetch(`${httpBase}/connectors/github/repos`, { headers: { 'x-session-token': sessionToken } })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setGhError(data.message || t('Could not list your repositories.')); return }
      setGhRepos(data.repos || [])
      if (!ghRepo && data.repos?.[0]) setGhRepo(data.repos[0].repo)
    } catch (err) { setGhError(err instanceof Error ? err.message : String(err)) }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [httpBase, sessionToken])
  // The OAuth journey: a page opens, GitHub asks, they say yes. Back here,
  // the status is watched until their GitHub shows as connected, then the
  // repositories are offered.
  const connectGithubAccount = async () => {
    setGhError(null)
    const tab = window.open('', '_blank')
    try {
      const res = await fetch(`${httpBase}/connectors/github/connect`, { method: 'POST', headers: { 'x-session-token': sessionToken } })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.redirectUrl) { tab?.close(); setGhError(data.message || t('Could not start that connection.')); return }
      if (tab) tab.location.href = data.redirectUrl
      else window.location.href = data.redirectUrl
      setGhWaiting(true)
      setGhOpen(true)
      const started = Date.now()
      const tick = async () => {
        const status = await loadGithubStatus()
        if (status?.mine) { setGhWaiting(false); await loadGithubRepos(); return }
        if (Date.now() - started < 3 * 60 * 1000) setTimeout(tick, 3000)
        else setGhWaiting(false)
      }
      setTimeout(tick, 3000)
    } catch (err) {
      tab?.close()
      setGhError(err instanceof Error ? err.message : String(err))
    }
  }
  const githubCall = async (method: 'PUT' | 'DELETE', body: Record<string, unknown>) => {
    setGhBusy(true); setGhError(null)
    try {
      const res = await fetch(`${httpBase}/connectors/github`, {
        method,
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ orgId, ...body }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setGhError(data.message || t('That did not save.')); return }
      setGithub(data)
      setGhRepo(''); setGhToken(''); setGhOpen(false)
    } catch (err) {
      setGhError(err instanceof Error ? err.message : String(err))
    } finally { setGhBusy(false) }
  }
  // The address that turns an email into a card. The Worker has answered with
  // it since inbound mail was built, and nothing has ever shown it to anyone —
  // so the connector existed and there was no way to use it.
  const [inbox, setInbox] = useState<string | null>(null)
  // Notion needs a database to read from and write back to. The phone has
  // had a picker for it; the web had the row and no way to point it.
  const [databases, setDatabases] = useState<Array<{ id: string; title: string }> | null>(null)
  const [databaseId, setDatabaseId] = useState<string>('')
  const [databaseError, setDatabaseError] = useState<string | null>(null)
  const [copiedInbox, setCopiedInbox] = useState(false)
  // What this deployment runs the AI on, straight from the Worker: the
  // model, whether System One (Jev) is switched on, and whether this
  // browser sends its own key. Nothing here is a promise the server has
  // not made.
  const [ai, setAI] = useState<AIStatus | null>(null)
  const [aiBusy, setAIBusy] = useState(false)
  const [aiError, setAIError] = useState<string | null>(null)
  const [aiNote, setAINote] = useState<string | null>(null)
  const [openaiDraft, setOpenaiDraft] = useState('')
  const [jevDraft, setJevDraft] = useState('')
  useEffect(() => {
    let ignore = false
    fetch(`${httpBase}/orgs/ai?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      .then((r) => (r.ok ? r.json() : null))
      .then((a) => { if (!ignore && a) setAI(a) })
      .catch(() => {})
    return () => { ignore = true }
  }, [httpBase, orgId, sessionToken])
  const saveAI = async (body: Record<string, unknown>, said: string) => {
    setAIBusy(true); setAIError(null); setAINote(null)
    try {
      const res = await fetch(`${httpBase}/orgs/ai`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ orgId, ...body }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setAIError(data.message || t('That did not save.')); return }
      setAI(data)
      setOpenaiDraft(''); setJevDraft('')
      setAINote(said)
    } catch (err) {
      setAIError(err instanceof Error ? err.message : String(err))
    } finally { setAIBusy(false) }
  }
  const ownKey = Boolean(getAIKey())

  // Agents. Claude Code, Cursor or a team's own agent asks a person here for
  // a decision; the question arrives as a card, the agent reads the answer.
  // This app stays the place a person decides — the agent comes to it.
  const [agents, setAgents] = useState<{ tokens: AgentToken[]; endpoint: string; tools: string[] } | null>(null)
  const [agentName, setAgentName] = useState('')
  const [agentBusy, setAgentBusy] = useState<string | null>(null)
  const [agentError, setAgentError] = useState<string | null>(null)
  const [minted, setMinted] = useState<{ token: string; name: string; endpoint: string } | null>(null)
  const [agentCopied, setAgentCopied] = useState<string | null>(null)
  const [revoking, setRevoking] = useState<string | null>(null)
  useEffect(() => {
    let ignore = false
    fetch(`${httpBase}/tokens?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => { if (!ignore && data) setAgents({ tokens: data.tokens || [], endpoint: data.endpoint || '', tools: data.tools || [] }) })
      .catch(() => { /* the section appears once the Worker answers */ })
    return () => { ignore = true }
  }, [httpBase, orgId, sessionToken])
  const createAgentToken = async () => {
    const name = agentName.trim()
    if (!name) return
    setAgentBusy('create'); setAgentError(null)
    try {
      const res = await fetch(`${httpBase}/tokens`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ orgId, name }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setAgentError(data.message || t('That did not save.')); return }
      setMinted({ token: data.token, name: data.name, endpoint: data.endpoint || agents?.endpoint || '' })
      setAgents((a) => ({
        tokens: [{ id: data.id, name: data.name, prefix: data.prefix, createdAt: data.createdAt, lastUsedAt: null }, ...(a?.tokens || [])],
        endpoint: data.endpoint || a?.endpoint || '',
        tools: a?.tools || [],
      }))
      setAgentName('')
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : String(err))
    } finally { setAgentBusy(null) }
  }
  const revokeAgentToken = async (id: string) => {
    setAgentBusy(id); setAgentError(null)
    try {
      const res = await fetch(`${httpBase}/tokens/${encodeURIComponent(id)}?orgId=${encodeURIComponent(orgId)}`, {
        method: 'DELETE',
        headers: { 'x-session-token': sessionToken },
      })
      if (!res.ok) { setAgentError((await res.json().catch(() => ({}))).message || t('That did not work. Try again in a moment.')); return }
      setAgents((a) => (a ? { ...a, tokens: a.tokens.filter((x) => x.id !== id) } : a))
      setRevoking(null)
    } catch (err) {
      setAgentError(err instanceof Error ? err.message : String(err))
    } finally { setAgentBusy(null) }
  }
  const copyAgent = (key: string, text: string) => {
    navigator.clipboard?.writeText(text)
    setAgentCopied(key)
    setTimeout(() => setAgentCopied((k) => (k === key ? null : k)), 1500)
  }
  const claudeCommand = minted ? `claude mcp add --transport http honmaru ${minted.endpoint} --header "Authorization: Bearer ${minted.token}"` : ''
  const mcpConfig = minted ? JSON.stringify({
    mcpServers: { honmaru: { type: 'http', url: minted.endpoint, headers: { Authorization: `Bearer ${minted.token}` } } },
  }, null, 2) : ''

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
  const notionOn = active.some((c) => c.id === 'notion')
  useEffect(() => {
    if (!notionOn) return
    let ignore = false
    Promise.all([
      fetch(`${httpBase}/connectors/notion/config`, { headers: { 'x-session-token': sessionToken } })
        .then((r) => (r.ok ? r.json() : {})).catch(() => ({})) as Promise<{ databaseId?: string | null }>,
      fetch(`${httpBase}/connectors/notion/databases`, { headers: { 'x-session-token': sessionToken } })
        .then(async (r) => (r.ok ? r.json() : Promise.reject(new Error((await r.json().catch(() => ({}))).message || '')))) as Promise<{ databases?: Array<{ id: string; title: string }> }>,
    ]).then(([config, list]) => {
      if (ignore) return
      setDatabaseId(String(config?.databaseId || ''))
      setDatabases(list?.databases || [])
    }).catch((err) => { if (!ignore) { setDatabases([]); setDatabaseError(err instanceof Error && err.message ? err.message : t('Could not list your databases.')) } })
    return () => { ignore = true }
  }, [notionOn, httpBase, sessionToken, t])
  const chooseDatabase = async (id: string) => {
    setDatabaseId(id)
    if (!id) return
    try {
      const res = await fetch(`${httpBase}/connectors/notion/config`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ databaseId: id }),
      })
      if (!res.ok) setError((await res.json().catch(() => ({}))).message || t('That did not save.'))
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
  }

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

        {ai && (
          <>
            <div className="rows-title">{t('Your AI')}</div>
            <div className="rows ai-status">
              <div className="row static ai-model">
                <span className="row-main">
                  {t('Language model')}
                  <span className="row-sub">
                    {t('Writes cards, answers, drafts and translations.')}
                    {' '}
                    {ai.modelSource === 'workspace' ? t('Chosen for this workspace.') : ai.modelSource === 'deployment' ? t('The deployment\u2019s default.') : t('No model is set up yet.')}
                  </span>
                </span>
                {ai.canEdit ? (
                  <select
                    className="row-select"
                    value={ai.modelSource === 'workspace' ? (ai.model || '') : ''}
                    disabled={aiBusy}
                    onChange={(e) => saveAI({ model: e.target.value || null }, t('Model saved for this workspace.'))}
                    aria-label={t('Language model')}
                  >
                    <option value="">{t('Default ({model})', { model: ai.modelSource === 'workspace' ? t('deployment') : (ai.model || t('none')) })}</option>
                    {ai.models.map((m) => (
                      <option key={m.id} value={m.id}>{m.id} · ${m.priceIn}/${m.priceOut} {t('per 1M tokens')}</option>
                    ))}
                  </select>
                ) : (
                  <span className="row-value">{ownKey ? t('Your own key') : ai.model || t('Off')}</span>
                )}
              </div>
              <div className="row static ai-key">
                <span className="row-main">
                  {t('OpenAI key for this workspace')}
                  <span className="row-sub">
                    {ai.openai === 'workspace'
                      ? t('Set ({hint}). Calls are billed to it.', { hint: ai.openaiHint || '' })
                      : ai.openai === 'deployment' ? t('Not set. Calls run on the deployment\u2019s key.') : t('Not set, and the deployment has none: the AI is off until one is entered.')}
                  </span>
                  {ai.canEdit && (
                    <span className="ai-key-form">
                      <input
                        className="ai-key-input"
                        type="password"
                        autoComplete="off"
                        value={openaiDraft}
                        onChange={(e) => setOpenaiDraft(e.target.value)}
                        placeholder="sk-…"
                        aria-label={t('OpenAI key for this workspace')}
                        disabled={aiBusy}
                      />
                      <button className="pill-btn" disabled={aiBusy || !openaiDraft.trim()} onClick={() => saveAI({ openaiKey: openaiDraft.trim() }, t('OpenAI key saved for this workspace.'))}>{t('Save')}</button>
                      {ai.openai === 'workspace' && (
                        <button className="btn-text danger" disabled={aiBusy} onClick={() => saveAI({ openaiKey: null }, t('OpenAI key removed.'))}>{t('Remove')}</button>
                      )}
                    </span>
                  )}
                </span>
              </div>
              <div className="row static ai-key">
                <span className="row-main">
                  {t('Jev (System One)')}
                  <span className="row-sub">
                    {ai.systemOne
                      ? t('Decides who and how urgent for a fraction of a cent; the model is asked only when it is unsure.')
                      : t('Off. Enter a TypeSafe API key and routing gets cheaper.')}
                    {ai.jev === 'workspace' && ` (${ai.jevHint})`}
                  </span>
                  {ai.canEdit && (
                    <span className="ai-key-form">
                      <input
                        className="ai-key-input"
                        type="password"
                        autoComplete="off"
                        value={jevDraft}
                        onChange={(e) => setJevDraft(e.target.value)}
                        placeholder={t('TypeSafe API key')}
                        aria-label={t('TypeSafe API key')}
                        disabled={aiBusy}
                      />
                      <button className="pill-btn" disabled={aiBusy || !jevDraft.trim()} onClick={() => saveAI({ typesafeKey: jevDraft.trim() }, t('Jev switched on for this workspace.'))}>{t('Save')}</button>
                      {ai.jev === 'workspace' && (
                        <button className="btn-text danger" disabled={aiBusy} onClick={() => saveAI({ typesafeKey: null }, t('Jev key removed.'))}>{t('Remove')}</button>
                      )}
                    </span>
                  )}
                </span>
                <span className={`row-value ${ai.systemOne ? 'on' : ''}`}>{ai.systemOne ? t('On') : t('Off')}</span>
              </div>
              {!ai.canEdit && <div className="form-note">{t('An admin of this workspace can change these.')}</div>}
              {aiNote && <div className="form-note">{aiNote}</div>}
              {aiError && <div className="form-error">{aiError}</div>}
            </div>
          </>
        )}

        {connectors === null && <div className="empty">{t('Loading…')}</div>}

        {connectors !== null && connectors.length > 0 && (
          <div className="rows">
            {connectors.map((c) => (
              <div key={c.id} className="row static">
                <span className="row-icon brand-tile">{isBrand(c.id) ? <BrandLogo brand={c.id} size={20} /> : <Icon name={ICON[c.id] || 'box'} size={18} />}</span>
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

        {notionOn && (
          <>
            <div className="rows-title">{t('Database')}</div>
            <div className="rows">
              <div className="row static" data-notion-database="1">
                <span className="row-icon brand-tile"><BrandLogo brand="notion" size={20} /></span>
                <span className="row-main">
                  {t('Database')}
                  <span className="row-sub">{databaseError || t('Which database your decisions are read from and written back to.')}</span>
                  {databases === null && !databaseError && <span className="row-sub">{t('Loading…')}</span>}
                  {databases && databases.length > 0 && (
                    <select className="row-select" value={databaseId} onChange={(e) => chooseDatabase(e.target.value)} aria-label={t('Database')}>
                      <option value="">{t('Choose a database…')}</option>
                      {databases.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                    </select>
                  )}
                </span>
              </div>
            </div>
          </>
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
            <div className="rows-title">{github.builtIn ? t('Always on') : github.connected ? t('Connected') : t('Not in this workspace')}</div>
            <div className="rows">
              <div className="row static github-row" data-github={github.builtIn || github.connected ? 'on' : 'off'}>
                <span className="row-icon brand-tile"><BrandLogo brand="github" size={20} /></span>
                <span className="row-main">
                  GitHub
                  <span className="row-sub">
                    {github.connected
                      ? t('Every decision here becomes an issue in {repo}.', { repo: github.repo || '' })
                      : github.builtIn ? t(BLURB.github) : t(github.reason || '')}
                  </span>
                </span>
                {github.builtIn
                  ? <span className="pill-tag mint">{t('Built in')}</span>
                  : github.connected
                    ? (github.canEdit
                      ? <button className="btn-text danger" disabled={ghBusy} onClick={() => githubCall('DELETE', {})}>{t('Disconnect')}</button>
                      : <span className="pill-tag mint">{t('On')}</span>)
                    : (github.canEdit
                      ? (github.mine || !github.oauth
                        ? <button className="pill-btn" onClick={() => { setGhOpen((o) => !o); setGhError(null); if (!ghOpen && github.mine && github.oauth) void loadGithubRepos() }}>{ghOpen ? t('Cancel') : t('Connect')}</button>
                        : <button className="pill-btn" disabled={ghWaiting} onClick={() => void connectGithubAccount()}>{ghWaiting ? t('Waiting for GitHub…') : t('Connect with GitHub')}</button>)
                      : <span className="pill-tag quiet">{t('Off')}</span>)}
              </div>
              {github.canEdit && !github.builtIn && !github.connected && ghOpen && (
                <div className="row static github-form-row">
                  <div className="github-form">
                    {ghWaiting && <span className="row-sub github-hint">{t('Finish in the tab that opened. This page updates by itself.')}</span>}
                    {!ghWaiting && github.mine && github.oauth && !ghUseToken && (
                      <>
                        {ghRepos === null && <span className="row-sub github-hint">{t('Loading your repositories…')}</span>}
                        {ghRepos && ghRepos.length === 0 && <span className="row-sub github-hint">{t('Your GitHub has no repository you can write issues to.')}</span>}
                        {ghRepos && ghRepos.length > 0 && (
                          <select className="row-select github-pick" value={ghRepo} onChange={(e) => setGhRepo(e.target.value)} aria-label={t('Repository')} disabled={ghBusy}>
                            {ghRepos.map((r) => <option key={r.repo} value={r.repo}>{r.repo}{r.private ? ` · ${t('private')}` : ''}</option>)}
                          </select>
                        )}
                        <button className="pill-btn" disabled={ghBusy || !ghRepo.trim()} onClick={() => githubCall('PUT', { repo: ghRepo.trim() })}>
                          {ghBusy ? t('Connecting…') : t('Use this repository')}
                        </button>
                        <span className="row-sub github-hint">{t('Connected with your GitHub account; the workspace writes issues as you.')}</span>
                      </>
                    )}
                    {!ghWaiting && (ghUseToken || !github.oauth || (!github.mine && !github.oauth)) && (
                      <>
                        <input
                          className="ai-key-input"
                          value={ghRepo}
                          onChange={(e) => setGhRepo(e.target.value)}
                          placeholder="owner/repo"
                          aria-label={t('Repository')}
                          disabled={ghBusy}
                        />
                        <input
                          className="ai-key-input"
                          type="password"
                          autoComplete="off"
                          value={ghToken}
                          onChange={(e) => setGhToken(e.target.value)}
                          placeholder={t('GitHub token (Issues: write)')}
                          aria-label={t('GitHub token')}
                          disabled={ghBusy}
                        />
                        <button className="pill-btn" disabled={ghBusy || !ghRepo.trim() || !ghToken.trim()}
                          onClick={() => githubCall('PUT', { repo: ghRepo.trim(), token: ghToken.trim() })}>
                          {ghBusy ? t('Connecting…') : t('Connect')}
                        </button>
                        <span className="row-sub github-hint">{t('A fine-grained token for that repository with Issues: read and write.')}</span>
                      </>
                    )}
                    {!ghWaiting && github.oauth && github.mine && (
                      <button className="btn-text github-alt" onClick={() => setGhUseToken((u) => !u)}>
                        {ghUseToken ? t('Pick from my GitHub instead') : t('Use a token instead')}
                      </button>
                    )}
                  </div>
                </div>
              )}
              {ghError && <div className="form-error">{ghError}</div>}
            </div>
          </>
        )}

        {agents && (
          <>
            <div className="rows-title">{t('Connect an agent')}</div>
            <div className="rows agents">
              <div className="row static agent-intro">
                <span className="row-icon"><Icon name="terminal" size={18} /></span>
                <span className="row-main">
                  {t('Claude Code, Cursor, or your own agent')}
                  <span className="row-sub">{t('agents.blurb')}</span>
                  {!minted && (
                    <span className="ai-key-form">
                      <input
                        className="ai-key-input"
                        value={agentName}
                        maxLength={60}
                        onChange={(e) => setAgentName(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void createAgentToken() }}
                        placeholder={t('e.g. Claude Code on my laptop')}
                        aria-label={t('Agent name')}
                        disabled={agentBusy === 'create'}
                      />
                      <button className="pill-btn" disabled={agentBusy === 'create' || !agentName.trim()} onClick={() => void createAgentToken()}>
                        {agentBusy === 'create' ? t('Creating…') : t('Create token')}
                      </button>
                    </span>
                  )}
                </span>
              </div>
              {minted && (
                <div className="row static agent-minted" data-agent-minted="1">
                  <div className="agent-steps">
                    <div className="agent-warn">{t('Copy this token now. It is shown once, and cannot be read again.')}</div>
                    <AgentSnippet label={t('Token for {name}', { name: minted.name })} text={minted.token} copied={agentCopied === 'token'} onCopy={() => copyAgent('token', minted.token)} />
                    <AgentSnippet label={t('Claude Code')} text={claudeCommand} copied={agentCopied === 'claude'} onCopy={() => copyAgent('claude', claudeCommand)} />
                    <AgentSnippet label={t('Any MCP client')} text={mcpConfig} copied={agentCopied === 'json'} onCopy={() => copyAgent('json', mcpConfig)} />
                    <button className="btn btn-ghost agent-done" onClick={() => setMinted(null)}>{t('Done')}</button>
                  </div>
                </div>
              )}
              {agents.tokens.map((tok) => (
                <div className="row static agent-token" key={tok.id} data-token={tok.id}>
                  <span className="row-main">
                    {tok.name}
                    <span className="row-sub">
                      <code className="agent-prefix">{tok.prefix}…</code>
                      {` · ${t('made {when}', { when: new Date(tok.createdAt).toLocaleDateString([], { month: 'short', day: 'numeric' }) })}`}
                      {` · ${tok.lastUsedAt ? t('last used {when}', { when: ago(tok.lastUsedAt) }) : t('never used')}`}
                    </span>
                  </span>
                  {revoking === tok.id ? (
                    <span className="team-confirm">
                      <button className="pill-btn" disabled={agentBusy === tok.id} onClick={() => void revokeAgentToken(tok.id)}>{t('Revoke')}</button>
                      <button className="btn-text" onClick={() => setRevoking(null)}>{t('Keep')}</button>
                    </span>
                  ) : (
                    <button className="btn-text danger" onClick={() => setRevoking(tok.id)}>{t('Revoke')}</button>
                  )}
                </div>
              ))}
              {agentError && <div className="form-error">{agentError}</div>}
            </div>
            {agents.tools.length > 0 && (
              <p className="hint insights-hint">{t('What an agent can do: {tools}.', { tools: agents.tools.join(', ') })}</p>
            )}
          </>
        )}
        <div style={{ height: 24 }} />
      </div>
    </div>
  )
}

/// One thing to paste somewhere else, and the button that copies it.
const AgentSnippet: React.FC<{ label: string; text: string; copied: boolean; onCopy: () => void }> = ({ label, text, copied, onCopy }) => {
  const t = useT()
  return (
    <div className="agent-snippet">
      <div className="agent-snippet-head">
        <span className="meta-label">{label}</span>
        <button className="btn-text" onClick={onCopy}>{copied ? t('Copied!') : t('Copy')}</button>
      </div>
      <pre className="agent-code"><code>{text}</code></pre>
    </div>
  )
}
