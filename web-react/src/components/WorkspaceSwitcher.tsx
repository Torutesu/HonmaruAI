import React, { useEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from './Icon'

export interface Workspace {
  id: string
  name: string | null
  role: string
  founder?: string | null
  mine?: boolean
  icon?: string | null
  memberCount?: number
}

interface Props {
  workspaces: Workspace[]
  currentId: string
  onSwitch: (orgId: string) => void
  onSettings: () => void
  onCreate: () => void
  onJoin: () => void
  onLogout: () => void
  /// Where it sits: on the rail (name beside the mark) or in a header.
  variant?: 'rail' | 'header'
  /// For "Add a workspace": making one, or joining one by its invitation.
  api?: { httpBase: string; sessionToken: string }
}

/// The workspace's name and mark, as the door into every other workspace
/// this person is in — the way a chat client's top-left corner works. The
/// mark is the logo an admin set, or the name's first letter until then.
export function workspaceLabel(w: Workspace | undefined, t: (k: string, v?: Record<string, string | number>) => string): string {
  if (!w) return t('Your workspace')
  if (w.name) return w.name
  if (w.id.includes('/')) return w.id
  if (w.mine) return t('Your workspace')
  return w.founder ? t("{name}'s team", { name: w.founder }) : t('A team you joined')
}

export const WorkspaceMark: React.FC<{ workspace?: Workspace; label: string; size?: number }> = ({ workspace, label, size = 32 }) => (
  workspace?.icon
    ? <img className="ws-mark" src={workspace.icon} alt="" width={size} height={size} style={{ width: size, height: size }} />
    : <span className="ws-mark ws-mark-letter" aria-hidden="true" style={{ width: size, height: size, fontSize: Math.round(size * 0.5) }}>{(label.trim()[0] || '?').toUpperCase()}</span>
)

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent)

export const WorkspaceSwitcher: React.FC<Props> = ({ workspaces, currentId, onSwitch, onSettings, onCreate, onJoin, onLogout, variant = 'rail', api }) => {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [adding, setAdding] = useState(false)
  // ⌘1–⌘9 (Ctrl on Windows): straight to a workspace, as in Slack. Only
  // the rail's switcher listens, so two on the page do not both jump.
  useEffect(() => {
    if (variant !== 'rail') return
    const onKey = (e: KeyboardEvent) => {
      if (!(isMac ? e.metaKey : e.ctrlKey) || e.altKey || e.shiftKey) return
      const n = /^Digit([1-9])$/.exec(e.code)?.[1]
      if (!n) return
      const w = workspaces[Number(n) - 1]
      if (!w) return
      e.preventDefault()
      if (w.id !== currentId) onSwitch(w.id)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [variant, workspaces, currentId, onSwitch])
  const box = useRef<HTMLDivElement>(null)
  // Workspaces your company's domain lets you ask to join.
  const [joinable, setJoinable] = useState<Array<{ orgId: string; name: string; domain: string; requested: boolean; declined: boolean }>>([])
  useEffect(() => {
    if (!open || !api) return
    fetch(`${api.httpBase}/orgs/joinable`, { headers: { 'x-session-token': api.sessionToken } })
      .then((r) => (r.ok ? r.json() : { workspaces: [] })).then((d) => setJoinable(d.workspaces || [])).catch(() => {})
  }, [open, api])
  const askToJoin = async (orgId: string) => {
    if (!api) return
    const res = await fetch(`${api.httpBase}/orgs/join-requests/ask`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-session-token': api.sessionToken }, body: JSON.stringify({ orgId }) })
    if (res.ok) setJoinable((list) => list.map((w) => (w.orgId === orgId ? { ...w, requested: true } : w)))
  }
  const current = workspaces.find((w) => w.id === currentId)
  const label = workspaceLabel(current, t)

  useEffect(() => {
    if (!open) return
    const onDown = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false) }
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => { document.removeEventListener('mousedown', onDown); document.removeEventListener('keydown', onKey) }
  }, [open])

  const go = (fn: () => void) => { setOpen(false); fn() }

  return (
    <div className={`ws ws-${variant}${open ? ' open' : ''}`} ref={box}>
      <button
        type="button"
        className="ws-button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={t('Switch workspace')}
        data-workspace={currentId}
      >
        <WorkspaceMark workspace={current} label={label} size={variant === 'rail' ? 32 : 28} />
        <span className="ws-name">{label}</span>
        <span className="ws-caret" aria-hidden="true"><Icon name="chevron-down" size={13} /></span>
      </button>
      {open && (
        <div className="ws-menu" role="menu" aria-label={t('Workspaces')}>
          <ul className="ws-list">
            {workspaces.map((w, i) => {
              const name = workspaceLabel(w, t)
              return (
                <li key={w.id}>
                  <button
                    type="button"
                    role="menuitemradio"
                    aria-checked={w.id === currentId}
                    className={`ws-item${w.id === currentId ? ' on' : ''}`}
                    data-org={w.id}
                    onClick={() => go(() => { if (w.id !== currentId) onSwitch(w.id) })}
                  >
                    <WorkspaceMark workspace={w} label={name} size={40} />
                    <span className="ws-item-text">
                      <span className="ws-item-name">{name}</span>
                      <span className="ws-item-role">
                        {w.memberCount && w.memberCount > 1 ? t('{n} members', { n: w.memberCount }) : t('Just you')}
                        {' · '}{t(w.role.charAt(0).toUpperCase() + w.role.slice(1))}
                      </span>
                    </span>
                    {i < 9 && <kbd className="ws-key" aria-hidden="true">{isMac ? '⌘' : 'Ctrl+'}{i + 1}</kbd>}
                  </button>
                </li>
              )
            })}
          </ul>
          {joinable.length > 0 && (
            <>
              <div className="ws-menu-sep" />
              <div className="ws-joinable-title">{t('At your company')}</div>
              {joinable.map((w) => (
                <div key={w.orgId} className="ws-joinable" data-joinable={w.orgId}>
                  <WorkspaceMark label={w.name} size={32} />
                  <span className="ws-item-text">
                    <span className="ws-item-name">{w.name}</span>
                    <span className="ws-item-role">{w.domain}</span>
                  </span>
                  <button type="button" className="ws-ask" disabled={w.requested || w.declined} onClick={() => void askToJoin(w.orgId)}>
                    {w.declined ? t('Declined') : w.requested ? t('Asked') : t('Ask to join')}
                  </button>
                </div>
              ))}
            </>
          )}
          <div className="ws-menu-sep" />
          <button type="button" role="menuitem" className="ws-action ws-add" onClick={() => go(() => (api ? setAdding(true) : onCreate()))} data-add-workspace="1">
            <span className="ws-add-plus" aria-hidden="true"><Icon name="plus" size={18} /></span>
            {t('Add a workspace')}
          </button>
          <div className="ws-menu-sep" />
          <button type="button" role="menuitem" className="ws-action" onClick={() => go(onSettings)}>{t('Workspace settings')}</button>
          <button type="button" role="menuitem" className="ws-action ws-quiet" onClick={() => go(onLogout)}>{t('Sign out')}</button>
        </div>
      )}
      {adding && api && (
        <AddWorkspace api={api} onClose={() => setAdding(false)} onDone={(orgId) => { setAdding(false); onSwitch(orgId) }} onJoin={onJoin} />
      )}
    </div>
  )
}

/// "Add a workspace": start a new one, or join one you were invited to —
/// by the link a teammate sent, or its code. Either way you land in it.
const AddWorkspace: React.FC<{
  api: { httpBase: string; sessionToken: string }
  onClose: () => void
  onDone: (orgId: string) => void
  onJoin: () => void
}> = ({ api, onClose, onDone }) => {
  const t = useT()
  const [mode, setMode] = useState<'choose' | 'create' | 'join'>('choose')
  const [value, setValue] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { if (mode !== 'choose') requestAnimationFrame(() => input.current?.focus()) }, [mode])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = async () => {
    const text = value.trim()
    if (!text || busy) return
    setBusy(true); setError(null)
    try {
      // A pasted link carries its code at the end: …#/join/<code>.
      const code = mode === 'join' ? (/(?:join\/|code=|invite=)([A-Za-z0-9_-]+)/.exec(text)?.[1] || text.split(/[/#?=]/).filter(Boolean).pop() || text) : ''
      const res = await fetch(`${api.httpBase}${mode === 'create' ? '/orgs' : '/invites/accept'}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': api.sessionToken },
        body: JSON.stringify(mode === 'create' ? { name: text } : { code }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok || !data.orgId) { setError(data.message || (mode === 'join' ? t('That invite code is not valid.') : t('That did not save.'))); return }
      onDone(data.orgId)
    } catch {
      setError(t('Could not reach the server.'))
    } finally { setBusy(false) }
  }

  return (
    <div className="ws-add-scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}>
      <div className="ws-add-dialog" role="dialog" aria-modal="true" aria-label={t('Add a workspace')}>
        <div className="ws-add-head">
          {mode !== 'choose' && <button type="button" className="ws-add-back" onClick={() => { setMode('choose'); setError(null); setValue('') }} aria-label={t('Back')}><Icon name="chevron-left" size={18} /></button>}
          <h2>{mode === 'create' ? t('Create a workspace') : mode === 'join' ? t('Join a workspace') : t('Add a workspace')}</h2>
          <button type="button" className="ws-add-close" onClick={onClose} aria-label={t('Close')}><Icon name="x" size={16} /></button>
        </div>
        {mode === 'choose' ? (
          <div className="ws-add-choices">
            <button type="button" className="ws-add-choice" onClick={() => setMode('create')} data-ws-create="1">
              <span className="ws-add-icon" aria-hidden="true"><Icon name="plus" size={20} /></span>
              <span><b>{t('Create a new workspace')}</b><small>{t('For a new team, company or project. You can invite people right after.')}</small></span>
            </button>
            <button type="button" className="ws-add-choice" onClick={() => setMode('join')} data-ws-join="1">
              <span className="ws-add-icon" aria-hidden="true"><Icon name="invite" size={20} /></span>
              <span><b>{t('Join with an invitation')}</b><small>{t('Paste the link or code a teammate sent you.')}</small></span>
            </button>
          </div>
        ) : (
          <form className="ws-add-form" onSubmit={(e) => { e.preventDefault(); void submit() }}>
            <label htmlFor="ws-add-input">{mode === 'create' ? t('Workspace name') : t('Invitation link or code')}</label>
            <input
              id="ws-add-input"
              ref={input}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder={mode === 'create' ? t('e.g. Acme Inc.') : t('https://…/#/join/…')}
              maxLength={mode === 'create' ? 60 : 400}
              data-ws-input="1"
            />
            <p className="ws-add-hint">{mode === 'create'
              ? t('You will be its admin. Its channels, people and emoji are its own.')
              : t('You keep every workspace you are already in.')}</p>
            {error && <div className="form-error" role="alert">{error}</div>}
            <button type="submit" className="pill-btn ws-add-go" disabled={busy || !value.trim()} data-ws-submit="1">
              {busy ? t('Working…') : mode === 'create' ? t('Create and open') : t('Join and open')}
            </button>
          </form>
        )}
      </div>
    </div>
  )
}
