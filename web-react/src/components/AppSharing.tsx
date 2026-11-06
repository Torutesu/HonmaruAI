import React, { useEffect, useState } from 'react'
import { useT } from '../utils/i18n'

interface Access { visibility: 'private' | 'workspace'; version: number }
interface PersonAccess { userId: string; login: string; name: string; permission: 'none' | 'view' | 'edit'; explicit: boolean; canOverride?: boolean; role?: 'owner' | 'admin' | 'member' | 'guest' }
interface AccessResponse { access: Access; people?: PersonAccess[]; canEdit?: boolean }
const MAX_PEOPLE = 100
export function AppSharing({ httpBase, orgId, sessionToken, appId }: { httpBase: string; orgId: string; sessionToken: string; appId: string }) {
  const t = useT()
  const [access, setAccess] = useState<Access | null>(null)
  const [people, setPeople] = useState<PersonAccess[]>([])
  const [filter, setFilter] = useState('')
  const [canEdit, setCanEdit] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    const controller = new AbortController()
    setAccess(null); setCanEdit(false); setError('')
    fetch(`${httpBase}/apps/${appId}/access?${new URLSearchParams({ orgId })}`, { headers: { 'x-session-token': sessionToken }, signal: controller.signal })
      .then(async res => { const data = await res.json(); if (!res.ok) throw new Error(data.message || String(res.status)); return data })
      .then((data: AccessResponse) => { if (!controller.signal.aborted) { setAccess(data.access); setPeople(Array.isArray(data.people) ? data.people.map(person => ({ ...person, explicit: Boolean(person.explicit) })) : []); setCanEdit(Boolean(data.canEdit)) } })
      .catch(err => { if (!controller.signal.aborted) setError(String(err.message)) })
    return () => controller.abort()
  }, [httpBase, orgId, sessionToken, appId])
  const save = async (visibility: Access['visibility'], nextPeople = people) => {
    if (!access) return
    setBusy(true); setError('')
    try {
      const res = await fetch(`${httpBase}/apps/${appId}/access`, { method: 'PUT', headers: { 'content-type': 'application/json', 'x-session-token': sessionToken }, body: JSON.stringify({ orgId, visibility, version: access.version, people: nextPeople.filter(person => person.explicit && person.canOverride !== false && person.role !== 'owner' && person.role !== 'admin').map(({ userId, permission }) => ({ userId, permission })) }) })
      const data: AccessResponse = await res.json()
      if (!res.ok) throw new Error(data.message || String(res.status))
      setAccess(data.access)
      setPeople(Array.isArray(data.people) ? data.people.map(person => ({ ...person, explicit: Boolean(person.explicit) })) : nextPeople)
    } catch (err) { setError(err instanceof Error ? err.message : String(err)) }
    finally { setBusy(false) }
  }
  const matchingPeople = people.filter(person => `${person.name} ${person.login}`.toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()))
  const visiblePeople = matchingPeople.slice(0, MAX_PEOPLE)
  const setPermission = (person: PersonAccess, permission: PersonAccess['permission'] | 'inherit') => {
    const next = people.map(candidate => candidate.userId === person.userId
      ? permission === 'inherit' ? { ...candidate, explicit: false } : { ...candidate, permission, explicit: true }
      : candidate)
    void save(access?.visibility || 'workspace', next)
  }
  return <section>
    <div className="rows-title">{t('Sharing')}</div>
    {error && <div className="form-error" role="alert">{error}</div>}
    {access && <div className="row static"><span className="row-main">
      <select aria-label={t('App visibility')} value={access.visibility} disabled={!canEdit || busy} onChange={e => void save(e.target.value as Access['visibility'])}>
        <option value="workspace">{t('Workspace members')}</option><option value="private">{t('Only me')}</option>
      </select>
      <span className="row-sub">{t('Sharing applies to this app and its records. Room links do not change access.')}</span>
    </span></div>}
    {access && people.length > 0 && <div className="app-sharing-people" aria-label={t('People with app access')}>
      <div className="rows-title">{t('Person access')}</div>
      <label className="app-sharing-filter">{t('Find a person')}
        <input type="search" value={filter} onChange={event => setFilter(event.target.value)} placeholder={t('Name or username')} />
      </label>
      <div className="app-sharing-person-list">
        {visiblePeople.map(person => <div className="row static app-sharing-person" key={person.userId}>
          <span className="row-main"><span>{person.name || person.login}</span><span className="row-sub">@{person.login}</span></span>
          <select aria-label={t('Access for {{name}}', { name: person.name || person.login })} value={person.explicit ? person.permission : 'inherit'} disabled={!canEdit || busy || person.canOverride === false || person.role === 'owner' || person.role === 'admin'} onChange={event => setPermission(person, event.target.value as PersonAccess['permission'] | 'inherit')}>
            <option value="inherit">{t('Inherit default ({{permission}})', { permission: person.permission === 'none' ? t('No access') : person.permission === 'view' ? t('View only') : t('Can edit') })}</option>
            <option value="none">{t('No access')}</option><option value="view">{t('View only')}</option><option value="edit">{t('Can edit')}</option>
          </select>
        </div>)}
        {visiblePeople.length === 0 && <div className="row-sub">{t('No people match this search.')}</div>}
      </div>
      {matchingPeople.length > MAX_PEOPLE && <div className="row-sub">{t('Showing {{shown}} of {{count}} people.', { shown: MAX_PEOPLE, count: matchingPeople.length })}</div>}
      <p className="row-sub">{t('No access overrides workspace visibility for this person.')}</p>
    </div>}
  </section>
}
