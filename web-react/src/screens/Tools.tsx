import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon, type IconName } from '../components/Icon'
import { EmojiManager } from '../components/EmojiManager'
import { UserGroupsManager } from '../components/UserGroupsManager'
import { BrandLogo, isBrand } from '../components/BrandLogo'
import { getAIKey } from '../utils/aiKey'
import { ago } from '../utils/ago'
import { Dialog } from '../components/Dialog'
import { InviteDialog } from '../components/InviteDialog'
import './Studio.css'

interface Connector { id: string; label: string; status: string }

type StudioPage = 'apps' | 'ai' | 'api' | 'emoji' | 'groups'

/// One tile in the catalogue: a connector of your own, the workspace's
/// GitHub, or the address that turns mail into cards.
interface App { id: string; label: string; blurb: string; scope: 'you' | 'workspace'; connected: boolean; available: boolean }

/// A webhook as the Worker lists it — never with its secret.
interface Webhook {
  id: string; name: string | null; url: string; events: string[]; includeDms: boolean
  createdAt: string; createdBy: string | null; mine: boolean
  lastStatus: number | null; lastDeliveryAt: string | null; lastError: string | null
}

/// What a deployment without connectors still lists, so the catalogue says
/// what could be here rather than showing nothing.
const FALLBACK_CONNECTORS: Connector[] = [
  { id: 'gmail', label: 'Gmail', status: 'none' },
  { id: 'slack', label: 'Slack', status: 'none' },
  { id: 'notion', label: 'Notion', status: 'none' },
]

/// A webhook's events, as words. English keys, translated where read.
const EVENT_WORD: Record<string, string> = {
  'message.created': 'Message created', 'message.updated': 'Message updated',
  'card.created': 'Decision created', 'card.decided': 'Decision made',
  'call.started': 'Jam started', 'call.ended': 'Jam ended', 'webhook.test': 'Webhook test',
}

/// What a key lets a tool do, from the MCP tools it can call.
const PERMISSIONS: Array<{ label: string; tools: string[] }> = [
  { label: 'Decisions: ask', tools: ['request_decision'] },
  { label: 'Decisions: read', tools: ['get_decision', 'list_pending', 'search_decisions'] },
  { label: 'Members: read', tools: ['list_members'] },
  { label: 'Playbook: read', tools: ['get_playbook'] },
]

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
  // Where this person's own tools are pulled into — named by the Worker.
  const [pullsInto, setPullsInto] = useState<{ orgId: string; name: string | null } | null>(null)
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
  const refreshTokens = useCallback(async () => {
    try {
      const r = await fetch(`${httpBase}/tokens?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      const data = r.ok ? await r.json() : null
      if (data) setAgents({ tokens: data.tokens || [], endpoint: data.endpoint || '', tools: data.tools || [] })
    } catch { /* the section appears once the Worker answers */ }
  }, [httpBase, orgId, sessionToken])
  useEffect(() => { void refreshTokens() }, [refreshTokens])
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
      setPullsInto(data.pullsInto || null)
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

  // ---- Studio: which page, and what each needs beyond the above ----

  const [page, setPage] = useState<StudioPage>(() => {
    const asked = (typeof window !== 'undefined' ? window.location.hash : '').split('/')[2]
    return asked === 'ai' || asked === 'api' || asked === 'emoji' || asked === 'groups' ? asked : 'apps'
  })
  const go = (next: StudioPage) => {
    setPage(next)
    try { history.replaceState(null, '', `#/tools${next === 'apps' ? '' : `/${next}`}`) } catch { /* the page still changes */ }
  }
  const [search, setSearch] = useState('')
  const [appOpen, setAppOpen] = useState<string | null>(null)
  const [inviting, setInviting] = useState<null | 'people' | 'agent'>(null)
  const [keyMenu, setKeyMenu] = useState(false)
  const [keyDialog, setKeyDialog] = useState(false)
  const [keyMenuFor, setKeyMenuFor] = useState<string | null>(null)
  // A menu closes when you click anywhere else, or press Escape.
  useEffect(() => {
    const away = (e: MouseEvent) => {
      if ((e.target as HTMLElement | null)?.closest?.('.studio-menu-wrap')) return
      setKeyMenu(false); setKeyMenuFor(null); setHookMenu(null)
    }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') { setKeyMenu(false); setKeyMenuFor(null); setHookMenu(null) } }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [])

  // Webhooks: the workspace's events, posted to a service of the team's own.
  const [hooks, setHooks] = useState<Webhook[] | null>(null)
  const [hookEvents, setHookEvents] = useState<string[]>([])
  const [hookDialog, setHookDialog] = useState(false)
  const [hookDraft, setHookDraft] = useState<{ url: string; name: string; events: string[]; includeDms: boolean }>({ url: '', name: '', events: ['message.created'], includeDms: false })
  const [hookBusy, setHookBusy] = useState<string | null>(null)
  const [hookError, setHookError] = useState<string | null>(null)
  const [hookSecret, setHookSecret] = useState<{ name: string; secret: string } | null>(null)
  const [hookNote, setHookNote] = useState<string | null>(null)
  const [hookMenu, setHookMenu] = useState<string | null>(null)
  const loadHooks = useCallback(async () => {
    try {
      const res = await fetch(`${httpBase}/webhooks?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setHooks([]); return }
      setHooks(data.webhooks || [])
      setHookEvents(data.events || [])
    } catch { setHooks([]) }
  }, [httpBase, orgId, sessionToken])
  useEffect(() => { if (page === 'api') void loadHooks() }, [page, loadHooks])
  const createHook = async () => {
    setHookBusy('create'); setHookError(null)
    try {
      const res = await fetch(`${httpBase}/webhooks`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ orgId, ...hookDraft }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setHookError(data.message || t('That did not save.')); return }
      setHooks((h) => [...(h || []), data.webhook])
      setHookSecret({ name: data.webhook.name || data.webhook.url, secret: data.secret })
      setHookDraft({ url: '', name: '', events: ['message.created'], includeDms: false })
    } catch (err) { setHookError(err instanceof Error ? err.message : String(err)) } finally { setHookBusy(null) }
  }
  const testHook = async (id: string) => {
    setHookBusy(id); setHookNote(null); setHookMenu(null)
    try {
      const res = await fetch(`${httpBase}/webhooks/${encodeURIComponent(id)}/test`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': sessionToken }, body: JSON.stringify({ orgId }),
      })
      const data = await res.json().catch(() => ({}))
      setHookNote(res.ok && data.ok ? t('Test delivered ({status}).', { status: data.status }) : t('The test did not arrive: {why}', { why: data.error || data.message || res.status }))
      void loadHooks()
    } catch (err) { setHookNote(err instanceof Error ? err.message : String(err)) } finally { setHookBusy(null) }
  }
  const deleteHook = async (id: string) => {
    setHookBusy(id); setHookMenu(null)
    try {
      const res = await fetch(`${httpBase}/webhooks/${encodeURIComponent(id)}?orgId=${encodeURIComponent(orgId)}`, { method: 'DELETE', headers: { 'x-session-token': sessionToken } })
      if (!res.ok) { setHookNote((await res.json().catch(() => ({}))).message || t('That did not work. Try again in a moment.')); return }
      setHooks((h) => (h || []).filter((x) => x.id !== id))
    } finally { setHookBusy(null) }
  }

  // ---- The apps, as one catalogue ----

  const known = connectors && connectors.length ? connectors : (unavailable ? FALLBACK_CONNECTORS : [])
  const apps: App[] = [
    ...known.map((c): App => ({ id: c.id, label: c.label, blurb: t(BLURB[c.id] || 'Feeds decisions into your feed.'), scope: 'you', connected: c.status === 'active', available: !unavailable })),
    ...(github ? [{ id: 'github', label: 'GitHub', blurb: github.connected ? t('Every decision here becomes an issue in {repo}.', { repo: github.repo || '' }) : github.builtIn ? t(BLURB.github) : t(github.reason || BLURB.github), scope: 'workspace' as const, connected: github.builtIn || github.connected, available: true }] : []),
    ...(inbox ? [{ id: 'email', label: t('Email forwarding'), blurb: t('Mail sent here becomes a card, triaged the way your inbox is.'), scope: 'you' as const, connected: true, available: true }] : []),
  ]
  const matches = apps.filter((a) => !search.trim() || `${a.label} ${a.blurb}`.toLowerCase().includes(search.trim().toLowerCase()))
  const connectedApps = apps.filter((a) => a.connected)
  const appIcon = (id: string, size = 20) => (
    <span className="app-icon brand-tile" aria-hidden="true">
      {id === 'email' ? <Icon name="mail" size={size - 2} /> : isBrand(id) ? <BrandLogo brand={id} size={size} /> : <Icon name={ICON[id] || 'box'} size={size - 2} />}
    </span>
  )
  const opened = apps.find((a) => a.id === appOpen) || null
  const pullElsewhere = pullsInto && pullsInto.orgId !== orgId
  const permissions = (agents?.tools || []).length ? PERMISSIONS.filter((p) => p.tools.some((x) => agents!.tools.includes(x))) : PERMISSIONS
  const day = (iso: string) => new Date(iso).toLocaleDateString([], { year: 'numeric', month: 'short', day: 'numeric' })

  const appsPage = (
    <section className="studio-page" data-studio-page="apps">
      <h1 className="studio-title">{t('Apps')}</h1>
      <p className="studio-lede">{t('studio.apps.lede')}</p>
      {unavailable && <div className="form-note">{unavailable}</div>}
      {note && <div className="form-note">{note}</div>}
      {error && <div className="form-error">{error}</div>}
      <div className="studio-toolbar">
        <label className="studio-search">
          <Icon name="search" size={14} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Search apps')} aria-label={t('Search apps')} />
        </label>
        {active.length > 0 && (
          <button className="studio-btn" onClick={pull} disabled={syncing} data-pull="1">
            <Icon name="refresh" size={14} /> {syncing ? t('Pulling…') : t('Pull now')}
          </button>
        )}
      </div>
      {connectors === null && <div className="empty">{t('Loading…')}</div>}
      <div className="studio-rule">
        <span>{t('Connected apps · {n}', { n: connectedApps.length })}</span>
        <i />
        <span className="studio-rule-icons">{connectedApps.slice(0, 6).map((a) => <span key={a.id}>{appIcon(a.id, 14)}</span>)}</span>
      </div>
      {(active.length > 0 || pullElsewhere) && (
        <p className="studio-hint">
          {pullElsewhere
            ? t('Your tools are pulled into “{name}” for now. Pull here, and from then on they come to this workspace.', { name: pullsInto!.name || t('another workspace') })
            : t('Pulled every 15 minutes into your own feed in this workspace.')}
        </p>
      )}
      <div className="studio-rule"><span>{t('All apps')}</span><i /></div>
      <div className="app-grid">
        {matches.map((a) => (
          <div key={a.id} className={`app-card${a.connected ? ' connected' : ''}`}
            data-connector={a.id !== 'github' && a.id !== 'email' ? a.id : undefined}
            data-github={a.id === 'github' ? (a.connected ? 'on' : 'off') : undefined}
            data-inbox={a.id === 'email' ? '1' : undefined}>
            <button type="button" className="app-open" onClick={() => setAppOpen(a.id)} aria-label={t('{app} settings', { app: a.label })}>
              {appIcon(a.id)}
              <span className="app-text">
                <span className="app-name">{a.label}<span className={`app-scope ${a.scope}`}>{a.scope === 'workspace' ? t('Whole workspace') : t('Just you')}</span></span>
                <span className="app-desc">{a.blurb}</span>
              </span>
            </button>
            {a.connected
              ? <span className="app-on"><Icon name="check" size={13} /> {t('Connected')}</span>
              : <button type="button" className="pill-btn app-add" disabled={!a.available || busy === a.id}
                  onClick={() => (a.id === 'github' ? (setAppOpen('github'), setGhOpen(true)) : void connect(a.id))}>
                  {busy === a.id ? '…' : t('Add')}
                </button>}
          </div>
        ))}
        {matches.length === 0 && connectors !== null && <p className="studio-empty">{search.trim() ? t('No app matches “{q}”.', { q: search.trim() }) : t('No connectors are available on this deployment.')}</p>}
      </div>
    </section>
  )

  const githubBody = github && (
    <>
      <p className="dlg-note github-status" data-github-status={github.builtIn || github.connected ? 'on' : 'off'}>
        {github.connected
          ? t('Every decision here becomes an issue in {repo}.', { repo: github.repo || '' })
          : github.builtIn ? t(BLURB.github) : t(github.reason || '')}
      </p>
      <p className="dlg-hint">{t('One repository for the whole workspace: every member’s decisions are recorded there, written as whoever connected it.')}</p>
      {github.connected && github.canEdit && (
        <div><button className="btn-text danger" disabled={ghBusy} onClick={() => githubCall('DELETE', {})}>{t('Disconnect')}</button></div>
      )}
      {!github.builtIn && !github.connected && !github.canEdit && <p className="dlg-note">{t('An admin of this workspace can change these.')}</p>}
      {github.canEdit && !github.builtIn && !github.connected && (
        <div className="github-form">
          {!ghOpen && (
            github.mine || !github.oauth
              ? <button className="pill-btn" onClick={() => { setGhOpen(true); setGhError(null); if (github.mine && github.oauth) void loadGithubRepos() }}>{t('Connect')}</button>
              : <button className="pill-btn" disabled={ghWaiting} onClick={() => void connectGithubAccount()}>{ghWaiting ? t('Waiting for GitHub…') : t('Connect with GitHub')}</button>
          )}
          {ghOpen && ghWaiting && <span className="row-sub github-hint">{t('Finish in the tab that opened. This page updates by itself.')}</span>}
          {ghOpen && !ghWaiting && github.mine && github.oauth && !ghUseToken && (
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
          {ghOpen && !ghWaiting && (ghUseToken || !github.oauth || (!github.mine && !github.oauth)) && (
            <>
              <input className="ai-key-input" value={ghRepo} onChange={(e) => setGhRepo(e.target.value)} placeholder="owner/repo" aria-label={t('Repository')} disabled={ghBusy} />
              <input className="ai-key-input" type="password" autoComplete="off" value={ghToken} onChange={(e) => setGhToken(e.target.value)} placeholder={t('GitHub token (Issues: write)')} aria-label={t('GitHub token')} disabled={ghBusy} />
              <button className="pill-btn" disabled={ghBusy || !ghRepo.trim() || !ghToken.trim()} onClick={() => githubCall('PUT', { repo: ghRepo.trim(), token: ghToken.trim() })}>
                {ghBusy ? t('Connecting…') : t('Connect')}
              </button>
              <span className="row-sub github-hint">{t('A fine-grained token for that repository with Issues: read and write.')}</span>
            </>
          )}
          {ghOpen && !ghWaiting && github.oauth && github.mine && (
            <button className="btn-text github-alt" onClick={() => setGhUseToken((u) => !u)}>
              {ghUseToken ? t('Pick from my GitHub instead') : t('Use a token instead')}
            </button>
          )}
        </div>
      )}
      {ghError && <div className="form-error">{ghError}</div>}
    </>
  )

  const appDialog = opened && (
    <Dialog
      className="app-dialog"
      title={opened.label}
      lede={opened.id === 'github' ? t(BLURB.github) : opened.blurb}
      art={appIcon(opened.id, 24)}
      onClose={() => { setAppOpen(null); setGhOpen(false) }}
      footer={opened.id !== 'github' && opened.id !== 'email' ? (
        opened.connected
          ? <button className="dlg-btn primary" onClick={() => void pull()} disabled={syncing}>{syncing ? t('Pulling…') : t('Pull now')}</button>
          : <button className="dlg-btn primary" onClick={() => void connect(opened.id)} disabled={!opened.available || busy === opened.id}>{t('Connect')}</button>
      ) : undefined}
    >
      {opened.id === 'github' ? githubBody : opened.id === 'email' ? (
        <>
          <div className="dlg-secret"><code>{inbox}</code>
            <button className="dlg-btn" onClick={() => { navigator.clipboard?.writeText(inbox || ''); setCopiedInbox(true); setTimeout(() => setCopiedInbox(false), 1500) }}>
              <Icon name="copy" size={13} /> {copiedInbox ? t('Copied!') : t('Copy')}
            </button>
          </div>
          <p className="dlg-hint">{t('Forward anything here')}</p>
        </>
      ) : (
        <>
          <p className="dlg-note">{opened.connected ? t('Connected with your own account.') : t('Not connected yet.')} {t('Only you see what it brings in; each member connects their own.')}</p>
          {opened.id === 'notion' && opened.connected && (
            <div data-notion-database="1">
              <div className="dlg-label">{t('Database')}</div>
              {databases === null && !databaseError && <p className="dlg-note">{t('Loading…')}</p>}
              {databases && databases.length > 0 && (
                <select className="row-select" value={databaseId} onChange={(e) => chooseDatabase(e.target.value)} aria-label={t('Database')}>
                  <option value="">{t('Choose a database…')}</option>
                  {databases.map((d) => <option key={d.id} value={d.id}>{d.title}</option>)}
                </select>
              )}
              <p className="dlg-hint">{databaseError || t('Which database your decisions are read from and written back to.')}</p>
            </div>
          )}
          {note && <p className="dlg-note">{note}</p>}
          {error && <p className="dlg-error">{error}</p>}
        </>
      )}
    </Dialog>
  )

  const aiPage = (
    <section className="studio-page" data-studio-page="ai">
      <h1 className="studio-title">{t('AI')}</h1>
      <p className="studio-lede">{t('What this workspace’s AI runs on. An admin chooses; everyone’s cards, answers and drafts use it.')}</p>
      {!ai && <div className="empty">{t('Loading…')}</div>}
      {ai && (
        <div className="rows ai-status">
          <div className="row static ai-model">
            <span className="row-main">
              {t('Language model')}
              <span className="row-sub">
                {t('Writes cards, answers, drafts and translations.')}
                {' '}
                {ai.modelSource === 'workspace' ? t('Chosen for this workspace.') : ai.modelSource === 'deployment' ? t('The deployment’s default.') : t('No model is set up yet.')}
              </span>
            </span>
            {ai.canEdit ? (
              <select className="row-select" value={ai.modelSource === 'workspace' ? (ai.model || '') : ''} disabled={aiBusy}
                onChange={(e) => saveAI({ model: e.target.value || null }, t('Model saved for this workspace.'))} aria-label={t('Language model')}>
                <option value="">{t('Default ({model})', { model: ai.modelSource === 'workspace' ? t('deployment') : (ai.model || t('none')) })}</option>
                {ai.models.map((m) => <option key={m.id} value={m.id}>{m.id} · ${m.priceIn}/${m.priceOut} {t('per 1M tokens')}</option>)}
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
                  : ai.openai === 'deployment' ? t('Not set. Calls run on the deployment’s key.') : t('Not set, and the deployment has none: the AI is off until one is entered.')}
              </span>
              {ai.canEdit && (
                <span className="ai-key-form">
                  <input className="ai-key-input" type="password" autoComplete="off" value={openaiDraft} onChange={(e) => setOpenaiDraft(e.target.value)}
                    placeholder="sk-…" aria-label={t('OpenAI key for this workspace')} disabled={aiBusy} />
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
                  <input className="ai-key-input" type="password" autoComplete="off" value={jevDraft} onChange={(e) => setJevDraft(e.target.value)}
                    placeholder={t('TypeSafe API key')} aria-label={t('TypeSafe API key')} disabled={aiBusy} />
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
      )}
    </section>
  )

  const apiPage = (
    <section className="studio-page" data-studio-page="api">
      <h1 className="studio-title">{t('API & Webhooks')}</h1>

      <div className="studio-section-head">
        <div>
          <h2>{t('API keys')}</h2>
          <p>{t('Keys for tools that act as you — Claude Code, Cursor, your own agent — over MCP.')}</p>
        </div>
        <div className="studio-menu-wrap">
          <button type="button" className="studio-btn primary studio-create-key" onClick={() => setKeyMenu((m) => !m)} aria-expanded={keyMenu} aria-haspopup="menu">
            <Icon name="plus" size={14} /> {t('Create key')} <Icon name="chevron-down" size={13} />
          </button>
          {keyMenu && (
            <div className="studio-menu" role="menu">
              <button type="button" role="menuitem" data-key-kind="personal" onClick={() => { setKeyMenu(false); setKeyDialog(true); setMinted(null) }}>
                <b>{t('Personal key')}</b><span>{t('For tools that act as you.')}</span>
              </button>
              <button type="button" role="menuitem" data-key-kind="agent" onClick={() => { setKeyMenu(false); setInviting('agent') }}>
                <b>{t('Agent invite link')}</b><span>{t('A single-use link an agent opens to get its own key.')}</span>
              </button>
            </div>
          )}
        </div>
      </div>
      <div className="studio-table keys" role="table" aria-label={t('API keys')}>
        <div className="studio-tr head" role="row">
          <span role="columnheader">{t('Name')}</span><span role="columnheader">{t('Permissions')}</span>
          <span role="columnheader">{t('Created')}</span><span role="columnheader">{t('Last used')}</span><span />
        </div>
        {agents && agents.tokens.length === 0 && (
          <div className="studio-empty-state">
            <span className="studio-empty-icon"><Icon name="key" size={16} /></span>
            <b>{t('No keys yet')}</b>
            <span>{t('Create one to let an agent ask you for decisions.')}</span>
          </div>
        )}
        {(agents?.tokens || []).map((tok) => (
          <div className="studio-tr agent-token" role="row" key={tok.id} data-token={tok.id}>
            <span className="studio-td-name"><b>{tok.name}</b><code className="agent-prefix">{tok.prefix}…</code></span>
            <span className="studio-chips">{permissions.map((p) => <i key={p.label}>{t(p.label)}</i>)}</span>
            <span className="studio-td-dim">{day(tok.createdAt)}</span>
            <span className="studio-td-dim">{tok.lastUsedAt ? t('last used {when}', { when: ago(tok.lastUsedAt) }) : t('never used')}</span>
            <span className="studio-td-end studio-menu-wrap">
              {revoking === tok.id ? (
                <span className="team-confirm">
                  <button className="pill-btn" disabled={agentBusy === tok.id} onClick={() => void revokeAgentToken(tok.id)}>{t('Revoke')}</button>
                  <button className="btn-text" onClick={() => setRevoking(null)}>{t('Keep')}</button>
                </span>
              ) : (
                <>
                  <button type="button" className="studio-icon-btn key-more" aria-label={t('More actions')} aria-expanded={keyMenuFor === tok.id} onClick={() => setKeyMenuFor((m) => (m === tok.id ? null : tok.id))}>
                    <Icon name="more" size={16} />
                  </button>
                  {keyMenuFor === tok.id && (
                    <div className="studio-menu right" role="menu">
                      <button type="button" role="menuitem" className="danger key-revoke" onClick={() => { setKeyMenuFor(null); setRevoking(tok.id) }}><b>{t('Revoke')}</b></button>
                    </div>
                  )}
                </>
              )}
            </span>
          </div>
        ))}
      </div>
      {agentError && <div className="form-error">{agentError}</div>}

      <div className="studio-section-head">
        <div>
          <h2>{t('Webhooks')}</h2>
          <p>{t('webhooks.lede')}</p>
        </div>
        <button type="button" className="studio-btn primary studio-create-hook" onClick={() => { setHookDialog(true); setHookSecret(null); setHookError(null) }}>
          <Icon name="plus" size={14} /> {t('Create webhook')}
        </button>
      </div>
      <div className="studio-table hooks" role="table" aria-label={t('Webhooks')}>
        <div className="studio-tr head" role="row">
          <span role="columnheader">{t('Name')}</span><span role="columnheader">URL</span>
          <span role="columnheader">{t('Events')}</span><span role="columnheader">{t('Last delivery')}</span><span />
        </div>
        {hooks === null && <div className="studio-empty-state"><span>{t('Loading…')}</span></div>}
        {hooks && hooks.length === 0 && (
          <div className="studio-empty-state">
            <span className="studio-empty-icon"><Icon name="send" size={16} /></span>
            <b>{t('No webhooks yet')}</b>
            <span>{t('Create one to send this workspace’s events to your service.')}</span>
            <button type="button" className="studio-btn" onClick={() => { setHookDialog(true); setHookSecret(null) }}><Icon name="plus" size={14} /> {t('Create webhook')}</button>
          </div>
        )}
        {(hooks || []).map((h) => (
          <div className="studio-tr webhook-row" role="row" key={h.id} data-webhook={h.id}>
            <span className="studio-td-name"><b>{h.name || t('Untitled')}</b><span className="studio-td-dim">{h.mine ? t('Yours') : t('by {name}', { name: h.createdBy || t('a teammate') })}</span></span>
            <span className="studio-td-url" title={h.url}>{h.url}</span>
            <span className="studio-chips">{h.events.map((e) => <i key={e}>{t(EVENT_WORD[e] || e)}</i>)}</span>
            <span className={`studio-td-dim hook-status${h.lastStatus && h.lastStatus < 300 ? ' ok' : h.lastDeliveryAt ? ' bad' : ''}`}>
              {h.lastDeliveryAt ? `${h.lastStatus || '—'} · ${ago(h.lastDeliveryAt)}` : t('Nothing sent yet')}
            </span>
            <span className="studio-td-end studio-menu-wrap">
              <button type="button" className="studio-icon-btn" aria-label={t('More actions')} aria-expanded={hookMenu === h.id} onClick={() => setHookMenu((m) => (m === h.id ? null : h.id))} disabled={hookBusy === h.id}>
                <Icon name="more" size={16} />
              </button>
              {hookMenu === h.id && (
                <div className="studio-menu right" role="menu">
                  {h.mine && <button type="button" role="menuitem" onClick={() => void testHook(h.id)}><b>{t('Send a test')}</b></button>}
                  <button type="button" role="menuitem" className="danger" onClick={() => void deleteHook(h.id)}><b>{t('Delete')}</b></button>
                </div>
              )}
            </span>
          </div>
        ))}
      </div>
      {hookNote && <div className="form-note" role="status">{hookNote}</div>}
    </section>
  )

  const keyDialogEl = keyDialog && (
    <Dialog
      className="key-dialog"
      title={t('Personal key')}
      lede={t('agents.blurb')}
      onClose={() => { setKeyDialog(false); setMinted(null) }}
      footer={minted
        ? <button className="dlg-btn primary agent-done" onClick={() => { setKeyDialog(false); setMinted(null) }}>{t('Done')}</button>
        : <>
            <button className="dlg-btn" onClick={() => setKeyDialog(false)}>{t('Cancel')}</button>
            <button className="dlg-btn primary" disabled={agentBusy === 'create' || !agentName.trim()} onClick={() => void createAgentToken()}>
              {agentBusy === 'create' ? t('Creating…') : t('Create key')}
            </button>
          </>}
    >
      {!minted && (
        <div className="agent-intro">
          <label className="dlg-label" htmlFor="key-name">{t('Name')}</label>
          <input id="key-name" className="dlg-input" value={agentName} maxLength={60} onChange={(e) => setAgentName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void createAgentToken() }} placeholder={t('e.g. Claude Code on my laptop')} aria-label={t('Agent name')} disabled={agentBusy === 'create'} />
        </div>
      )}
      {minted && (
        <div className="agent-minted" data-agent-minted="1">
          <p className="dlg-warn">{t('Copy this token now. It is shown once, and cannot be read again.')}</p>
          <AgentSnippet label={t('Token for {name}', { name: minted.name })} text={minted.token} copied={agentCopied === 'token'} onCopy={() => copyAgent('token', minted.token)} />
          <AgentSnippet label={t('Claude Code')} text={claudeCommand} copied={agentCopied === 'claude'} onCopy={() => copyAgent('claude', claudeCommand)} />
          <AgentSnippet label={t('Any MCP client')} text={mcpConfig} copied={agentCopied === 'json'} onCopy={() => copyAgent('json', mcpConfig)} />
        </div>
      )}
      {agentError && <p className="dlg-error">{agentError}</p>}
    </Dialog>
  )

  const hookDialogEl = hookDialog && (
    <Dialog
      className="hook-dialog"
      title={hookSecret ? t('Webhook created') : t('New webhook')}
      lede={hookSecret ? undefined : t('Each delivery is signed with a secret you will see once, right after the webhook is created.')}
      onClose={() => { setHookDialog(false); setHookSecret(null) }}
      footer={hookSecret
        ? <button className="dlg-btn primary" onClick={() => { setHookDialog(false); setHookSecret(null) }}>{t('Done')}</button>
        : <>
            <button className="dlg-btn" onClick={() => setHookDialog(false)}>{t('Cancel')}</button>
            <button className="dlg-btn primary hook-create" disabled={hookBusy === 'create' || !hookDraft.url.trim() || !hookDraft.events.length} onClick={() => void createHook()}>
              {hookBusy === 'create' ? t('Creating…') : t('Create webhook')}
            </button>
          </>}
    >
      {hookSecret ? (
        <>
          <p className="dlg-warn">{t('Copy the signing secret now. It is shown once, and cannot be read again.')}</p>
          <div className="dlg-secret hook-secret"><code>{hookSecret.secret}</code>
            <button className="dlg-btn" onClick={() => { navigator.clipboard?.writeText(hookSecret.secret).catch(() => {}) }}><Icon name="copy" size={13} /> {t('Copy')}</button>
          </div>
          <p className="dlg-hint">{t('Check honmaru-signature: t=<time>,v1=<HMAC-SHA256 of “<time>.<body>” with this secret>.')}</p>
        </>
      ) : (
        <>
          <div>
            <label className="dlg-label" htmlFor="hook-url">{t('Endpoint URL')}</label>
            <input id="hook-url" className="dlg-input hook-url" value={hookDraft.url} onChange={(e) => setHookDraft((d) => ({ ...d, url: e.target.value }))} placeholder="https://example.com/honmaru/webhooks" inputMode="url" autoComplete="off" />
          </div>
          <div>
            <label className="dlg-label" htmlFor="hook-name">{t('Name')} <span className="dlg-optional">{t('Optional')}</span></label>
            <input id="hook-name" className="dlg-input" value={hookDraft.name} onChange={(e) => setHookDraft((d) => ({ ...d, name: e.target.value }))} placeholder={t('Production events')} />
          </div>
          <div>
            <div className="dlg-label">{t('Events')}</div>
            <div className="dlg-grid">
              {(hookEvents.length ? hookEvents : Object.keys(EVENT_WORD)).map((e) => (
                <label key={e} className="dlg-check">
                  <input type="checkbox" checked={hookDraft.events.includes(e)} data-event={e}
                    onChange={() => setHookDraft((d) => ({ ...d, events: d.events.includes(e) ? d.events.filter((x) => x !== e) : [...d.events, e] }))} />
                  {t(EVENT_WORD[e] || e)}
                </label>
              ))}
            </div>
          </div>
          <div>
            <div className="dlg-label">{t('Delivery scope')}</div>
            <label className="dlg-check">
              <input type="checkbox" checked={hookDraft.includeDms} onChange={() => setHookDraft((d) => ({ ...d, includeDms: !d.includeDms }))} />
              {t('Include direct messages you are part of')}
            </label>
            <p className="dlg-hint">{t('A webhook acts as the member who made it, and only hears what they could see.')}</p>
          </div>
          {hookError && <p className="dlg-error">{hookError}</p>}
        </>
      )}
    </Dialog>
  )

  const NAV: Array<{ id: StudioPage; label: string; icon: IconName }> = [
    { id: 'apps', label: t('Apps'), icon: 'grid' },
    { id: 'ai', label: t('AI'), icon: 'sparkle' },
    { id: 'api', label: t('API & Webhooks'), icon: 'code' },
    { id: 'emoji', label: t('Emoji'), icon: 'smile' },
    { id: 'groups', label: t('User groups'), icon: 'users' },
  ]

  return (
    <div className="screen screen-wide tools-screen">
      <div className="screen-head">
        <button className="back" onClick={onClose} aria-label={t('Close')}>‹</button>
        <span className="head-title">{t('Tools')}</span>
      </div>
      <div className="screen-body">
        <div className="studio">
          <nav className="studio-nav" aria-label={t('Tools')}>
            <div className="studio-nav-label"><Icon name="settings" size={13} /> {t('Studio')}</div>
            {NAV.map((n) => (
              <button key={n.id} type="button" data-studio={n.id} className={page === n.id ? 'on' : ''} aria-current={page === n.id ? 'page' : undefined} onClick={() => go(n.id)}>
                <Icon name={n.icon} size={15} /> {n.label}
              </button>
            ))}
            <div className="studio-nav-sep" />
            <button type="button" className="studio-nav-invite" onClick={() => setInviting('people')}><Icon name="invite" size={15} /> {t('Invite')}</button>
          </nav>
          <main className="studio-main">
            {page === 'apps' && appsPage}
            {page === 'ai' && aiPage}
            {page === 'api' && apiPage}
            {page === 'emoji' && <EmojiManager httpBase={httpBase} orgId={orgId} sessionToken={sessionToken} />}
            {page === 'groups' && <UserGroupsManager httpBase={httpBase} orgId={orgId} sessionToken={sessionToken} />}
          </main>
        </div>
      </div>
      {appDialog}
      {keyDialogEl}
      {hookDialogEl}
      {inviting && (
        <InviteDialog httpBase={httpBase} orgId={orgId} sessionToken={sessionToken} initialTab={inviting} onClose={() => { setInviting(null); void refreshTokens() }} />
      )}
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
