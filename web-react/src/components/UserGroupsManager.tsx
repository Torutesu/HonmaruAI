import React, { useEffect, useMemo, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from './Icon'
import { Avatar } from './Avatar'

// User groups, in the Studio: "@sales" names everyone in it, so one mention
// reaches them all — in Activity, on their phones, and when your AI decides
// who a request is for. Anyone here can make one or change who is in it.

interface Member { ref: string; name: string; avatarUrl?: string | null; title?: string | null; mine?: boolean }
interface Group { handle: string; name: string; refs: string[]; createdBy: string | null }

export const UserGroupsManager: React.FC<{ httpBase: string; orgId: string; sessionToken: string }> = ({ httpBase, orgId, sessionToken }) => {
  const t = useT()
  const [groups, setGroups] = useState<Group[] | null>(null)
  const [members, setMembers] = useState<Member[]>([])
  const [editing, setEditing] = useState<null | { creating: boolean; handle: string; name: string; refs: string[] }>(null)
  const [query, setQuery] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const headers = useMemo(() => ({ 'x-session-token': sessionToken, 'content-type': 'application/json' }), [sessionToken])

  useEffect(() => {
    const q = `orgId=${encodeURIComponent(orgId)}`
    fetch(`${httpBase}/channels/usergroups?${q}`, { headers }).then((r) => r.json()).then((d) => setGroups(d.groups || [])).catch(() => setGroups([]))
    fetch(`${httpBase}/channels?${q}`, { headers }).then((r) => r.json()).then((d) => setMembers(d.members || [])).catch(() => {})
  }, [httpBase, orgId, headers])

  const nameOf = (ref: string) => members.find((m) => m.ref === ref)?.name || t('a teammate')
  const save = async () => {
    if (!editing) return
    setBusy(true); setError(null)
    try {
      const res = await fetch(`${httpBase}/channels/usergroups`, {
        method: editing.creating ? 'POST' : 'PUT', headers,
        body: JSON.stringify({ orgId, handle: editing.handle, name: editing.name, refs: editing.refs }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not save.')); return }
      setGroups(data.groups || [])
      setEditing(null)
    } finally { setBusy(false) }
  }
  const remove = async (g: Group) => {
    if (!window.confirm(t('Delete @{handle}? Messages that used it stay as they are.', { handle: g.handle }))) return
    setError(null)
    const res = await fetch(`${httpBase}/channels/usergroups`, { method: 'DELETE', headers, body: JSON.stringify({ orgId, handle: g.handle }) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) { setError(res.status === 403 ? t('Only whoever made it, or an admin, can delete it.') : (data.message || t('That did not save.'))); return }
    setGroups(data.groups || [])
  }
  const needle = query.trim().toLowerCase()
  const shown = members.filter((m) => !needle || m.name.toLowerCase().includes(needle) || (m.title || '').toLowerCase().includes(needle))

  return (
    <section className="studio-page" data-studio-page="groups">
      <h1 className="studio-title">{t('User groups')}</h1>
      <p className="studio-lede">{t('A group is a name for several people — write @sales, and everyone in it is told, as if you had named each of them. Anyone here can make one or change who is in it.')}</p>
      {error && <div className="form-error">{error}</div>}
      <div className="studio-section-head">
        <div><h2>{t('Groups in this workspace')}</h2></div>
        <button type="button" className="studio-btn primary" onClick={() => { setEditing({ creating: true, handle: '', name: '', refs: [] }); setQuery('') }} data-group-new="1">
          <Icon name="plus" size={14} /> {t('New group')}
        </button>
      </div>
      {groups && groups.length === 0 && !editing && <p className="studio-empty">{t('No groups yet. Make one for a team, a shift, or everyone on a project.')}</p>}
      {editing && (
        <div className="ug-editor" data-group-editor="1">
          <div className="ug-fields">
            <label>
              <span>{t('Handle')}</span>
              <span className="ug-handle"><b>@</b><input value={editing.handle} disabled={!editing.creating} onChange={(e) => setEditing({ ...editing, handle: e.target.value.replace(/^@+/, '') })} placeholder={t('e.g. sales')} maxLength={30} data-group-handle="1" /></span>
            </label>
            <label>
              <span>{t('Name')}</span>
              <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder={t('e.g. Sales team')} maxLength={60} />
            </label>
          </div>
          <label className="studio-search">
            <Icon name="search" size={15} />
            <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={t('Find somebody')} aria-label={t('Find somebody')} />
          </label>
          <div className="ug-people" role="listbox" aria-multiselectable="true" aria-label={t('People')}>
            {shown.map((m) => {
              const on = editing.refs.includes(m.ref)
              return (
                <button key={m.ref} type="button" role="option" aria-selected={on} className={`ug-person${on ? ' on' : ''}`} data-group-person={m.name}
                  onClick={() => setEditing({ ...editing, refs: on ? editing.refs.filter((r) => r !== m.ref) : [...editing.refs, m.ref] })}>
                  <Avatar name={m.name} url={m.avatarUrl} size={26} />
                  <span>{m.name}{m.title && <small> · {m.title}</small>}</span>
                  <span className="ug-tick" aria-hidden="true">{on && <Icon name="check" size={13} />}</span>
                </button>
              )
            })}
          </div>
          <div className="ug-actions">
            <span className="ug-count">{t('{n} people', { n: editing.refs.length })}</span>
            <button type="button" className="studio-btn" onClick={() => setEditing(null)} disabled={busy}>{t('Cancel')}</button>
            <button type="button" className="studio-btn primary" onClick={() => void save()} disabled={busy || !editing.handle.trim()} data-group-save="1">
              {editing.creating ? t('Create') : t('Save')}
            </button>
          </div>
        </div>
      )}
      {groups && groups.length > 0 && (
        <div className="ug-list">
          {groups.map((g) => (
            <div key={g.handle} className="ug-row" data-group={g.handle}>
              <span className="ug-mark" aria-hidden="true"><Icon name="users" size={16} /></span>
              <span className="ug-text">
                <b>@{g.handle}</b> <span className="ug-name">{g.name}</span>
                <small>{g.refs.length ? g.refs.map(nameOf).join(', ') : t('Nobody yet')}</small>
              </span>
              <button type="button" className="studio-btn" onClick={() => { setEditing({ creating: false, handle: g.handle, name: g.name, refs: g.refs }); setQuery('') }}>{t('Edit')}</button>
              <button type="button" className="studio-icon-btn" onClick={() => void remove(g)} aria-label={t('Delete @{handle}', { handle: g.handle })}><Icon name="trash" size={14} /></button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
