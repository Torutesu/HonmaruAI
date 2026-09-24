import React, { useEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'

export interface Workspace {
  id: string
  name: string | null
  role: string
  founder?: string | null
  mine?: boolean
  icon?: string | null
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

export const WorkspaceSwitcher: React.FC<Props> = ({ workspaces, currentId, onSwitch, onSettings, onCreate, onJoin, onLogout, variant = 'rail' }) => {
  const t = useT()
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
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
        <span className="ws-caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="ws-menu" role="menu">
          <div className="ws-menu-title">{t('Workspaces')}</div>
          <ul className="ws-list">
            {workspaces.map((w) => {
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
                    <WorkspaceMark workspace={w} label={name} size={28} />
                    <span className="ws-item-text">
                      <span className="ws-item-name">{name}</span>
                      <span className="ws-item-role">{t(w.role.charAt(0).toUpperCase() + w.role.slice(1))}</span>
                    </span>
                    {w.id === currentId && <span className="ws-check" aria-hidden="true">✓</span>}
                  </button>
                </li>
              )
            })}
          </ul>
          <div className="ws-menu-sep" />
          <button type="button" role="menuitem" className="ws-action" onClick={() => go(onSettings)}>{t('Workspace settings')}</button>
          <button type="button" role="menuitem" className="ws-action" onClick={() => go(onCreate)}>{t('Create a team')}</button>
          <button type="button" role="menuitem" className="ws-action" onClick={() => go(onJoin)}>{t('Join a team')}</button>
          <div className="ws-menu-sep" />
          <button type="button" role="menuitem" className="ws-action ws-quiet" onClick={() => go(onLogout)}>{t('Sign out')}</button>
        </div>
      )}
    </div>
  )
}
