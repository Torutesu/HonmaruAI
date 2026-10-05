import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'

// AI teammates, in the Studio: Claude, Devin and Cursor set up for the whole
// workspace, the way Claude Tag is in Slack. Each works with the workspace's
// own account at its company (billed there); HonmaruAI counts what it uses
// and stops it at the month's limit. Nothing secret ever comes back from the
// Worker: only whether it is set.

type Provider = 'claude' | 'devin' | 'cursor' | 'codex'
const PROVIDERS: Provider[] = ['claude', 'devin', 'cursor', 'codex']

interface Tool { name: string; secretName: string; host: string; secretValue?: string }
interface Teammate {
  provider: Provider; name: string; handle: string; emoji: string; company: string; keyHint: string; keySource: string
  models: string[]; freeModel: boolean; unit: 'usd' | 'acu' | 'task'
  needs: { apiKey: boolean; githubToken: boolean; tools: boolean; account: boolean; repos: boolean }
  enabled: boolean; hasKey: boolean; hasApiKey: boolean; hasGithubToken: boolean; account: string
  repos: string[]; model: string; instructions: string; channels: string[] | null
  monthlyLimit: number | null; spentThisMonth: number; tools: Tool[]; ready: boolean
  /// Claude: an issue link or a bug report posted in a channel starts it.
  autoBuild?: boolean
}
interface Channel { slug: string; name: string }

interface Draft {
  apiKey: string; githubToken: string; account: string; model: string; instructions: string; repos: string
  everywhere: boolean; channels: Set<string>; limit: string; tools: Tool[]; autoBuild: boolean
}

const draftOf = (tm: Teammate): Draft => ({
  apiKey: '', githubToken: '', account: tm.account, model: tm.model, instructions: tm.instructions, repos: tm.repos.join('\n'),
  everywhere: tm.channels === null, channels: new Set((tm.channels || []).filter((c) => c.startsWith('b:')).map((c) => c.slice(2))),
  limit: tm.monthlyLimit === null ? '' : String(tm.monthlyLimit), tools: tm.tools.map((x) => ({ ...x, secretValue: '' })),
  autoBuild: tm.autoBuild !== false,
})

export const AiTeammates: React.FC<{ httpBase: string; orgId: string; sessionToken: string }> = ({ httpBase, orgId, sessionToken }) => {
  const t = useT()
  const [all, setAll] = useState<Partial<Record<Provider, Teammate>>>({})
  const [which, setWhich] = useState<Provider>('claude')
  const [canEdit, setCanEdit] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [channels, setChannels] = useState<Channel[]>([])
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [failed, setFailed] = useState(false)
  const tm = all[which] || null

  const load = useCallback(async () => {
    const got = await Promise.all(PROVIDERS.map(async (p) => {
      const res = await fetch(`${httpBase}/teammates?orgId=${encodeURIComponent(orgId)}&provider=${p}`, { headers: { 'x-session-token': sessionToken } }).catch(() => null)
      return res?.ok ? await res.json().catch(() => null) : null
    }))
    if (!got[0]?.teammate) { setFailed(true); return }
    setCanEdit(Boolean(got[0].canEdit))
    setAll(Object.fromEntries(got.filter((g) => g?.teammate).map((g) => [g.teammate.provider, g.teammate])))
  }, [httpBase, orgId, sessionToken])
  useEffect(() => { void load() }, [load])
  // The form follows the teammate chosen, and what was last saved for it.
  useEffect(() => { if (tm) setDraft(draftOf(tm)) }, [tm])
  useEffect(() => {
    let ignore = false
    fetch(`${httpBase}/businesses?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      .then((r) => (r.ok ? r.json() : { businesses: [] }))
      .then((data) => { if (!ignore) setChannels((data.businesses || []).map((b: Channel) => ({ slug: b.slug, name: b.name }))) })
      .catch(() => {})
    return () => { ignore = true }
  }, [httpBase, orgId, sessionToken])

  const amount = (mate: Teammate, n: number) => (mate.unit === 'usd' ? `$${n.toFixed(2)}` : mate.unit === 'acu' ? t('{n} ACUs', { n: String(Math.round(n * 10) / 10) }) : t('{n} tasks', { n: String(Math.round(n)) }))

  const save = async (enabled?: boolean) => {
    if (!draft || !tm) return
    setBusy(true); setError(null); setNote(null)
    const body: Record<string, unknown> = {
      orgId, provider: tm.provider, instructions: draft.instructions,
      repos: draft.repos.split(/[\s,]+/).map((r) => r.trim()).filter(Boolean),
      channels: draft.everywhere ? null : [...draft.channels].map((s) => `b:${s}`),
      monthlyLimit: draft.limit.trim() ? Number(draft.limit) : null,
    }
    if (tm.provider === 'claude') body.autoBuild = draft.autoBuild
    if (tm.models.length || tm.freeModel) body.model = draft.model
    if (tm.needs.account) body.account = draft.account
    if (tm.needs.tools) body.tools = draft.tools.map((x) => ({ name: x.name, secretName: x.secretName, host: x.host, ...(x.secretValue?.trim() ? { secretValue: x.secretValue.trim() } : {}) }))
    if (draft.apiKey.trim()) body.apiKey = draft.apiKey.trim()
    if (tm.needs.githubToken && draft.githubToken.trim()) body.githubToken = draft.githubToken.trim()
    if (enabled !== undefined) body.enabled = enabled
    try {
      const res = await fetch(`${httpBase}/teammates`, { method: 'PUT', headers: { 'x-session-token': sessionToken, 'content-type': 'application/json' }, body: JSON.stringify(body) })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not save.')); return }
      setAll((prev) => ({ ...prev, [tm.provider]: data.teammate }))
      setNote(enabled === true ? t('{name} is on. Write @{handle} in a channel to hand it work.', { name: tm.name, handle: data.teammate.handle }) : enabled === false ? t('{name} is off.', { name: tm.name }) : t('Saved.'))
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(false) }
  }

  const set = (patch: Partial<Draft>) => setDraft((d) => (d ? { ...d, ...patch } : d))
  const setTool = (i: number, patch: Partial<Tool>) => setDraft((d) => (d ? { ...d, tools: d.tools.map((x, j) => (j === i ? { ...x, ...patch } : x)) } : d))
  const toggleChannel = (slug: string) => setDraft((d) => {
    if (!d) return d
    const next = new Set(d.channels)
    if (next.has(slug)) next.delete(slug); else next.add(slug)
    return { ...d, channels: next }
  })
  const pick = (p: Provider) => { setWhich(p); setNote(null); setError(null) }

  if (failed) return <section className="studio-page" data-studio-page="teammates"><h1 className="studio-title">{t('AI teammates')}</h1><p className="form-error" role="alert">{t('That did not load.')}</p></section>
  if (!tm || !draft) return <section className="studio-page" data-studio-page="teammates"><h1 className="studio-title">{t('AI teammates')}</h1><p className="row-sub">{t('Loading…')}</p></section>

  const off = !canEdit || busy
  const statusOf = (mate: Teammate) => (mate.enabled ? t('On') : mate.hasKey ? t('Off') : t('Not set up'))
  const unitLabel = tm.unit === 'usd' ? t('Monthly limit (USD)') : tm.unit === 'acu' ? t('Monthly limit (ACUs)') : t('Monthly limit (tasks)')

  return (
    <section className="studio-page sso-page teammates-page" data-studio-page="teammates">
      <h1 className="studio-title">{t('AI teammates')}</h1>
      <p className="studio-lede">{t('Hand work to a coding agent in a channel, as you would to a colleague: write @claude, @devin or @cursor in a thread and it takes the work on in a sandbox of its own — reads your repositories, runs code, opens pull requests — and answers in the thread. Each runs on your own account with its company, which bills you directly; HonmaruAI counts what it uses and stops it at the month’s limit.')}</p>

      <div className="teammate-picker" role="tablist" aria-label={t('AI teammates')}>
        {PROVIDERS.map((p) => {
          const mate = all[p]
          if (!mate) return null
          return (
            <button key={p} type="button" role="tab" aria-selected={which === p} className={`teammate-card${which === p ? ' on' : ''}`} data-teammate={p} onClick={() => pick(p)}>
              <span className="teammate-card-head"><span className="teammate-mark" aria-hidden="true">{mate.emoji}</span><b>{mate.name}</b><span className={`sso-badge${mate.enabled ? ' ok' : ''}`} data-teammate-status>{statusOf(mate)}</span></span>
              <code>@{mate.handle}</code>
              <span className="row-sub" data-teammate-spent>
                {mate.monthlyLimit === null
                  ? t('This month: {used}', { used: amount(mate, mate.spentThisMonth) })
                  : t('This month: {used} of {limit}', { used: amount(mate, mate.spentThisMonth), limit: amount(mate, mate.monthlyLimit) })}
              </span>
            </button>
          )
        })}
      </div>

      {note && <p className="rules-note" role="status">{note}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}

      <form className="teammate-form" data-teammate-form={tm.provider} onSubmit={(e) => { e.preventDefault(); void save() }}>
        {tm.needs.apiKey ? (
          <>
          <div className="studio-section-head"><div><h2>{t('{company} account', { company: tm.company })}</h2><p>{t('Make an API key in {source}, ideally for an account made for {name} here, so its use is billed and limited on its own.', { source: tm.provider === 'claude' ? t('the Claude Console') : tm.provider === 'devin' ? t('Devin’s settings, as a service user') : t('the Cursor dashboard'), name: tm.name })}</p></div></div>
          <label className="teammate-field">
            <span>{t('API key')}</span>
            <input className="rules-number wide" type="password" autoComplete="off" disabled={off} value={draft.apiKey} placeholder={tm.hasApiKey ? t('Saved. Paste a new one to replace it.') : tm.keyHint} onChange={(e) => set({ apiKey: e.target.value })} data-teammate-key />
          </label>
          </>
        ) : (
          <div className="studio-section-head"><div><h2>{t('How Codex is reached')}</h2><p>{t('Codex has no API to hand work to, so HonmaruAI asks it on GitHub: each request opens a draft pull request in the first repository below and writes @codex there, and Codex’s replies come back to the thread. Connect that repository to Codex in ChatGPT and turn on Codex for it first; Codex runs on your ChatGPT plan.')}</p></div></div>
        )}
        {tm.needs.account && (
          <label className="teammate-field">
            <span>{t('Devin organization ID')}</span>
            <input className="rules-number wide" disabled={off} value={draft.account} placeholder="org-…" onChange={(e) => set({ account: e.target.value })} data-teammate-account />
          </label>
        )}
        {tm.models.length > 0 && (
          <label className="teammate-field">
            <span>{t('Model')}</span>
            <select className="rules-number wide" disabled={off} value={draft.model} onChange={(e) => set({ model: e.target.value })} data-teammate-model>
              {tm.models.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
        )}
        {tm.freeModel && (
          <label className="teammate-field">
            <span>{t('Model')}</span>
            <input className="rules-number wide" disabled={off} value={draft.model} placeholder={t('Default')} onChange={(e) => set({ model: e.target.value })} data-teammate-model />
            <small>{t('A model ID from your Cursor account, or blank for its default.')}</small>
          </label>
        )}
        <label className="teammate-field">
          <span>{unitLabel}</span>
          <input className="rules-number" type="number" min={1} step={1} disabled={off} value={draft.limit} placeholder={t('None')} onChange={(e) => set({ limit: e.target.value })} data-teammate-limit />
          <small>{tm.provider === 'codex'
            ? t('Codex runs on your ChatGPT plan, so its limit here is a number of tasks: each request and follow-up is one.')
            : tm.unit === 'task'
            ? t('Cursor reports tokens, not cost, so its limit is a number of tasks: each request and follow-up is one.')
            : t('When the month’s use reaches it, {name} says so instead of starting work. Each task is also capped at what is left.', { name: tm.name })}</small>
        </label>
        <label className="teammate-field">
          <span>{t('Instructions')}</span>
          <textarea className="rules-number wide" rows={4} disabled={off} value={draft.instructions} placeholder={t('How your team works: conventions, where things are, what to avoid.')} onChange={(e) => set({ instructions: e.target.value })} data-teammate-instructions />
        </label>

        <div className="studio-section-head"><div><h2>{t('Code')}</h2><p>{tm.needs.githubToken
          ? (tm.needs.apiKey
            ? t('The repositories Claude may clone and open pull requests on, and a GitHub token that can reach them. It never pushes to the default branch.')
            : t('The repository Codex works in (the first one listed), and a GitHub token that can push to it and open pull requests.'))
          : t('The repositories {name} works on. Connect them to your {company} account first.', { name: tm.name, company: tm.company })}</p></div></div>
        {tm.needs.githubToken && (
          <label className="teammate-field">
            <span>{t('GitHub token')}</span>
            <input className="rules-number wide" type="password" autoComplete="off" disabled={off} value={draft.githubToken} placeholder={tm.hasGithubToken ? t('Saved. Paste a new one to replace it.') : 'github_pat_…'} onChange={(e) => set({ githubToken: e.target.value })} data-teammate-github />
          </label>
        )}
        <label className="teammate-field">
          <span>{t('Repositories')}</span>
          <textarea className="rules-number wide" rows={3} disabled={off} value={draft.repos} placeholder={'acme/app\nacme/api'} onChange={(e) => set({ repos: e.target.value })} data-teammate-repos />
          <small>{t('One per line, as owner/name. Up to 10.')}</small>
        </label>

        {tm.needs.tools && (
          <>
            <div className="studio-section-head"><div><h2>{t('Tools')}</h2><p>{t('Services Claude may call, such as Linear or Sentry. Each key goes to Anthropic’s vault and is added only to requests to its host; Claude never sees it.')}</p></div></div>
            {draft.tools.map((x, i) => (
              <div key={i} className="teammate-tool" data-teammate-tool={x.name || i}>
                <input className="rules-number" disabled={off} value={x.name} placeholder={t('Name')} aria-label={t('Name')} onChange={(e) => setTool(i, { name: e.target.value })} />
                <input className="rules-number" disabled={off} value={x.secretName} placeholder="LINEAR_API_KEY" aria-label={t('Variable')} onChange={(e) => setTool(i, { secretName: e.target.value.toUpperCase() })} />
                <input className="rules-number" disabled={off} value={x.host} placeholder="api.linear.app" aria-label={t('Host')} onChange={(e) => setTool(i, { host: e.target.value })} />
                <input className="rules-number" type="password" autoComplete="off" disabled={off} value={x.secretValue || ''} placeholder={tm.tools.some((y) => y.secretName === x.secretName) ? t('Saved') : t('Key')} aria-label={t('Key')} onChange={(e) => setTool(i, { secretValue: e.target.value })} />
                {canEdit && <button type="button" className="studio-btn danger" disabled={busy} onClick={() => set({ tools: draft.tools.filter((_, j) => j !== i) })}>{t('Remove')}</button>}
              </div>
            ))}
            {canEdit && draft.tools.length < 20 && (
              <div className="rules-actions"><button type="button" className="studio-btn" disabled={busy} data-teammate-add-tool onClick={() => set({ tools: [...draft.tools, { name: '', secretName: '', host: '', secretValue: '' }] })}>{t('Add a tool')}</button></div>
            )}
          </>
        )}

        <div className="studio-section-head"><div><h2>{t('Channels')}</h2><p>{t('Where @{handle} takes work. Group conversations always count; elsewhere it says it is not set up.', { handle: tm.handle })}</p></div></div>
        <div className="teammate-where">
          <label><input type="radio" name="teammate-where" disabled={off} checked={draft.everywhere} onChange={() => set({ everywhere: true })} data-teammate-everywhere /> {t('Every channel')}</label>
          <label><input type="radio" name="teammate-where" disabled={off} checked={!draft.everywhere} onChange={() => set({ everywhere: false })} data-teammate-some /> {t('Only these channels')}</label>
        </div>
        {!draft.everywhere && (
          <ul className="teammate-channels">
            {channels.map((c) => (
              <li key={c.slug}><label><input type="checkbox" disabled={off} checked={draft.channels.has(c.slug)} onChange={() => toggleChannel(c.slug)} data-teammate-channel={c.slug} /> #{c.name}</label></li>
            ))}
            {!channels.length && <li className="row-sub">{t('No channels yet.')}</li>}
          </ul>
        )}
        {tm.provider === 'claude' && (
          <>
            <div className="studio-section-head"><div><h2>{t('Start on its own')}</h2><p>{t('When a GitHub issue from these repositories is linked in a channel, or someone reports a bug or asks for a feature there, @{handle} starts on it in that message\'s thread and posts the pull request there. Each issue is started once.', { handle: tm.handle })}</p></div></div>
            <div className="teammate-where">
              <label><input type="checkbox" disabled={off} checked={draft.autoBuild} onChange={() => set({ autoBuild: !draft.autoBuild })} data-teammate-autobuild /> {t('Start on issues and reports posted in channels')}</label>
            </div>
          </>
        )}

        {canEdit
          ? (
            <div className="rules-actions teammate-save">
              <button type="submit" className="studio-btn" disabled={busy} data-teammate-save>{busy ? t('Saving…') : t('Save')}</button>
              {tm.enabled
                ? <button type="button" className="studio-btn" disabled={busy} data-teammate-off onClick={() => void save(false)}>{t('Turn off')}</button>
                : <button type="button" className="studio-btn primary" disabled={busy || (!tm.hasKey && !(tm.needs.apiKey ? draft.apiKey : draft.githubToken).trim())} data-teammate-on onClick={() => void save(true)}>{t('Save and turn on')}</button>}
            </div>
          )
          : <p className="form-note">{t('An admin of this workspace can change these.')}</p>}
      </form>
    </section>
  )
}
