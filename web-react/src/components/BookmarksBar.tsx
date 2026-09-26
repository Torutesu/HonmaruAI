import React, { useCallback, useEffect, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from './Icon'

// Bookmarks: links kept at the top of a conversation — the shared sheet,
// the dashboard, the spec — as in Slack. Anyone in the conversation sees
// them and may add one; whoever added one, or an admin, may remove it.

export interface Bookmark { id: string; title: string; url: string; addedBy: string | null; mine: boolean; createdAt: string }

interface Props { httpBase: string; orgId: string; headers: Record<string, string>; view: string }

export const BookmarksBar: React.FC<Props> = ({ httpBase, orgId, headers, view }) => {
  const t = useT()
  const [items, setItems] = useState<Bookmark[]>([])
  const [adding, setAdding] = useState<null | { id?: string; url: string; title: string }>(null)
  const [menu, setMenu] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const res = await fetch(`${httpBase}/channels/bookmarks?orgId=${encodeURIComponent(orgId)}&channel=${encodeURIComponent(view)}`, { headers }).catch(() => null)
    const data = res?.ok ? await res.json().catch(() => null) : null
    setItems(data?.bookmarks || [])
  }, [httpBase, orgId, headers, view])
  useEffect(() => { setItems([]); setAdding(null); setMenu(null); void load() }, [load])

  // Somebody else changed the bar.
  useEffect(() => {
    const on = (e: Event) => {
      const { name, value } = (e as CustomEvent<{ name: string; value: any }>).detail || {}
      if (name === 'channel_bookmarks' && value?.channel === view) void load()
    }
    window.addEventListener('honmaru:jam', on)
    return () => window.removeEventListener('honmaru:jam', on)
  }, [view, load])

  const send = async (method: 'POST' | 'PUT' | 'DELETE', body: Record<string, unknown>) => {
    setBusy(true); setError(null)
    try {
      const res = await fetch(`${httpBase}/channels/bookmarks`, {
        method, headers: { ...headers, 'content-type': 'application/json' }, body: JSON.stringify({ orgId, channel: view, ...body }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('That did not save.')); return false }
      setItems(data.bookmarks || [])
      return true
    } finally { setBusy(false) }
  }
  const save = async () => {
    if (!adding) return
    const url = /^https?:\/\//i.test(adding.url.trim()) ? adding.url.trim() : `https://${adding.url.trim()}`
    const ok = adding.id
      ? await send('PUT', { id: adding.id, url, title: adding.title })
      : await send('POST', { url, title: adding.title })
    if (ok) setAdding(null)
  }

  const host = (url: string) => { try { return new URL(url).hostname.replace(/^www\./, '') } catch { return url } }

  return (
    <div className="slk-bookmarks" data-bookmarks={view}>
      {items.map((b) => (
        <span key={b.id} className="slk-bookmark" data-bookmark={b.id}>
          <a href={b.url} target="_blank" rel="noopener noreferrer" title={`${b.title} — ${host(b.url)}${b.addedBy ? ` · ${t('added by {name}', { name: b.addedBy })}` : ''}`}>
            <Icon name="link" size={12} />
            <span>{b.title}</span>
          </a>
          <button type="button" className="slk-bookmark-more" aria-label={t('More actions')} aria-expanded={menu === b.id} onClick={() => setMenu((m) => (m === b.id ? null : b.id))}>
            <Icon name="chevron-down" size={11} />
          </button>
          {menu === b.id && (
            <div className="slk-menu slk-bookmark-menu" role="menu" onMouseLeave={() => setMenu(null)}>
              <button type="button" role="menuitem" onClick={() => { setMenu(null); void navigator.clipboard?.writeText(b.url) }}>{t('Copy link')}</button>
              <button type="button" role="menuitem" onClick={() => { setMenu(null); setAdding({ id: b.id, url: b.url, title: b.title }) }}>{t('Edit')}</button>
              <button type="button" role="menuitem" className="danger" data-bookmark-remove="1" onClick={() => { setMenu(null); void send('DELETE', { id: b.id }) }}>{t('Remove')}</button>
            </div>
          )}
        </span>
      ))}
      {!adding && (
        <button type="button" className="slk-bookmark-add" onClick={() => { setError(null); setAdding({ url: '', title: '' }) }} data-bookmark-add="1">
          <Icon name="plus" size={12} /> {items.length ? '' : t('Add a bookmark')}
        </button>
      )}
      {adding && (
        <form className="slk-bookmark-form" onSubmit={(e) => { e.preventDefault(); void save() }}>
          <input autoFocus value={adding.url} onChange={(e) => setAdding({ ...adding, url: e.target.value })} placeholder="https://…" aria-label={t('Link')} inputMode="url" data-bookmark-url="1" />
          <input value={adding.title} onChange={(e) => setAdding({ ...adding, title: e.target.value })} placeholder={t('Name (optional)')} aria-label={t('Name')} maxLength={80} data-bookmark-title="1" />
          <button type="submit" className="pill-btn" disabled={busy || !adding.url.trim()} data-bookmark-save="1">{adding.id ? t('Save') : t('Add')}</button>
          <button type="button" className="btn-text" onClick={() => setAdding(null)}>{t('Cancel')}</button>
        </form>
      )}
      {error && <span className="slk-bookmark-error" role="alert">{error}</span>}
    </div>
  )
}
