import React, { useState, useEffect, useCallback } from 'react'

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
}

// The org id routes sockets and is stored inside card data, so it never
// changes — but a person should not have to read `personal:a3f9c2…` to know
// which team they are in. This shows the name and, for an admin, lets them
// set it. An org with no name falls back to its id rather than showing nothing.
export const OrgName: React.FC<Props> = ({ httpBase, orgId, sessionToken }) => {
  const [name, setName] = useState(orgId)
  const [canRename, setCanRename] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${httpBase}/orgs/name?orgId=${encodeURIComponent(orgId)}`, {
        headers: { 'x-session-token': sessionToken },
      })
      if (!res.ok) return
      const data = await res.json()
      setName(data.name || orgId)
      setCanRename(data.role === 'admin')
    } catch {
      // Falling back to the id is the point: a name is a convenience, and the
      // feed should not care that this request failed.
    }
  }, [httpBase, orgId, sessionToken])

  useEffect(() => { load() }, [load])

  const save = async () => {
    const next = draft.trim()
    if (!next) return
    setBusy(true)
    setError(null)
    try {
      const res = await fetch(`${httpBase}/orgs/name?orgId=${encodeURIComponent(orgId)}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ name: next }),
      })
      const data = await res.json()
      if (!res.ok) { setError(data.message || 'Could not rename.'); return }
      setName(data.name)
      setEditing(false)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (editing) {
    return (
      <span className="org-info">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') save()
            if (e.key === 'Escape') { setEditing(false); setError(null) }
          }}
          maxLength={60}
          autoFocus
          style={{ padding: '0.2rem 0.4rem', borderRadius: '4px' }}
        />
        <button onClick={save} disabled={busy} style={{ marginLeft: '0.4rem' }}>
          {busy ? 'Saving…' : 'Save'}
        </button>
        <button onClick={() => { setEditing(false); setError(null) }} style={{ marginLeft: '0.25rem' }}>
          Cancel
        </button>
        {error && <span className="create-error" style={{ marginLeft: '0.5rem' }}>{error}</span>}
      </span>
    )
  }

  return (
    <span className="org-info">
      {name}
      {canRename && (
        <button
          onClick={() => { setDraft(name); setEditing(true) }}
          title="Rename this organization"
          style={{ marginLeft: '0.4rem', fontSize: '0.75rem', opacity: 0.7 }}
        >
          Rename
        </button>
      )}
    </span>
  )
}
