import React, { useEffect, useState } from 'react'
import { useT } from '../utils/i18n'

interface Props {
  httpBase: string
  sessionToken: string
  login: string
  onPick: (fullName: string) => void
  onLogout: () => void
}

interface Repo { full_name: string; private?: boolean; description?: string | null; permissions?: { push?: boolean; admin?: boolean; maintain?: boolean } }

/// A GitHub sign-in is a person; a workspace is a repository. Pick one you
/// can write to — that is the rule the relay applies when the feed connects,
/// so a repository you can only read would be a workspace that refuses you.
export const PickRepository: React.FC<Props> = ({ httpBase, sessionToken, login, onPick, onLogout }) => {
  const t = useT()
  const [repos, setRepos] = useState<Repo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')

  useEffect(() => {
    let ignore = false
    fetch(`${httpBase}/github/user/repos?per_page=100&sort=updated`, { headers: { 'x-session-token': sessionToken } })
      .then(async (r) => {
        if (!r.ok) throw new Error((await r.json().catch(() => ({}))).message || t('Could not list your repositories.'))
        return r.json()
      })
      .then((list: Repo[]) => { if (!ignore) setRepos((Array.isArray(list) ? list : []).filter((r) => r.permissions?.push || r.permissions?.admin || r.permissions?.maintain)) })
      .catch((err) => { if (!ignore) setError(err instanceof Error ? err.message : String(err)) })
    return () => { ignore = true }
  }, [httpBase, sessionToken, t])

  const q = query.trim().toLowerCase()
  const shown = (repos || []).filter((r) => !q || r.full_name.toLowerCase().includes(q))

  return (
    <div className="screen">
      <div className="screen-head">
        <span className="head-title">{t('Choose a repository')}</span>
      </div>
      <div className="screen-body">
        <p className="lede" style={{ marginTop: 8 }}>{t('Signed in as {login}. Your workspace is a repository you can write to; decisions there can become issues.', { login })}</p>
        <input
          className="alias-input"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('Filter repositories')}
          aria-label={t('Filter repositories')}
        />
        {error && <div className="form-error">{error}</div>}
        {repos === null && !error && <div className="empty">{t('Loading…')}</div>}
        {repos && shown.length === 0 && <div className="empty">{t('No repository you can write to.')}</div>}
        <div className="rows">
          {shown.map((r) => (
            <button key={r.full_name} className="row" onClick={() => onPick(r.full_name)} data-repo={r.full_name}>
              <span className="row-main">{r.full_name}{r.description ? <span className="row-sub">{r.description}</span> : null}</span>
              <span className="row-chevron">›</span>
            </button>
          ))}
        </div>
        <button className="btn btn-quiet" onClick={onLogout}>{t('Sign out')}</button>
        <div style={{ height: 24 }} />
      </div>
    </div>
  )
}
