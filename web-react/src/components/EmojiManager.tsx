import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from './Icon'
import { loadCustomEmoji, useCustomEmoji, emojiNameFrom } from '../utils/customEmoji'

// The workspace's own emoji, in the Studio: every one it has, and adding
// more — one, or a whole set at once, each named after its file, which is
// how a team's pack arrives. Only this workspace gets them.

const TYPES = ['image/png', 'image/gif', 'image/webp', 'image/jpeg', 'image/svg+xml']
const MAX_BYTES = 512 * 1024
const NAME = /^[a-z0-9_+-]{1,30}$/

interface Pending { file: File; name: string; preview: string; state: 'ready' | 'adding' | 'added' | 'failed'; why?: string }

export const EmojiManager: React.FC<{ httpBase: string; orgId: string; sessionToken: string }> = ({ httpBase, orgId, sessionToken }) => {
  const t = useT()
  const list = useCustomEmoji()
  const [search, setSearch] = useState('')
  const [pending, setPending] = useState<Pending[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [over, setOver] = useState(false)
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => { void loadCustomEmoji(httpBase, sessionToken, orgId) }, [httpBase, sessionToken, orgId])
  useEffect(() => () => { for (const p of pending) URL.revokeObjectURL(p.preview) }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const taken = useMemo(() => new Set(list.map((e) => e.name)), [list])
  const needle = search.trim().toLowerCase().replace(/:/g, '')
  const shown = list.filter((e) => !needle || e.name.includes(needle))

  const pick = (files: FileList | File[] | null) => {
    if (!files) return
    const next: Pending[] = []
    for (const file of Array.from(files)) {
      const type = file.type || (file.name.toLowerCase().endsWith('.svg') ? 'image/svg+xml' : '')
      const name = emojiNameFrom(file.name)
      const bad = !TYPES.includes(type) ? t('Not a PNG, GIF, WebP, JPEG or SVG.') : file.size > MAX_BYTES ? t('Larger than 512 KB.') : null
      next.push({ file, name, preview: URL.createObjectURL(file), state: bad ? 'failed' : 'ready', why: bad || undefined })
    }
    setPending((p) => [...p.filter((x) => x.state !== 'added'), ...next])
  }

  const problem = (p: Pending, all: Pending[]) => {
    if (p.state === 'failed' || p.state === 'added') return p.why || null
    if (!NAME.test(p.name)) return t('A name is letters, numbers, - _ and +.')
    if (taken.has(p.name)) return t(':{name}: is already taken.', { name: p.name })
    if (all.filter((x) => x.name === p.name && x.state !== 'failed').length > 1) return t('Two with the same name.')
    return null
  }
  const ready = pending.filter((p) => p.state === 'ready' && !problem(p, pending))

  const addAll = async () => {
    setBusy(true); setError(null)
    for (const p of ready) {
      setPending((all) => all.map((x) => (x.file === p.file ? { ...x, state: 'adding' } : x)))
      try {
        const type = p.file.type || 'image/svg+xml'
        const res = await fetch(`${httpBase}/emoji?orgId=${encodeURIComponent(orgId)}&name=${encodeURIComponent(p.name)}`, {
          method: 'POST', headers: { 'x-session-token': sessionToken, 'content-type': type }, body: p.file,
        })
        const data = await res.json().catch(() => ({})) as { message?: string }
        setPending((all) => all.map((x) => (x.file === p.file ? { ...x, state: res.ok ? 'added' : 'failed', why: res.ok ? undefined : (data.message || t('That did not save.')) } : x)))
      } catch {
        setPending((all) => all.map((x) => (x.file === p.file ? { ...x, state: 'failed', why: t('Could not reach the server.') } : x)))
      }
    }
    await loadCustomEmoji(httpBase, sessionToken, orgId)
    setBusy(false)
  }

  const remove = async (name: string) => {
    if (!window.confirm(t('Remove :{name}: from this workspace? Messages that used it will show its name instead.', { name }))) return
    setError(null)
    const res = await fetch(`${httpBase}/emoji?orgId=${encodeURIComponent(orgId)}&name=${encodeURIComponent(name)}`, { method: 'DELETE', headers: { 'x-session-token': sessionToken } })
    if (!res.ok) {
      const data = await res.json().catch(() => ({})) as { message?: string }
      setError(res.status === 403 ? t('Only whoever added it, or an admin, can remove it.') : (data.message || t('That did not save.')))
      return
    }
    await loadCustomEmoji(httpBase, sessionToken, orgId)
  }

  return (
    <section className="studio-page" data-studio-page="emoji">
      <h1 className="studio-title">{t('Emoji')}</h1>
      <p className="studio-lede">{t('This workspace’s own emoji. Only people here can use them — in a message as :name:, or as a reaction. Anyone here can add one; whoever added it, or an admin, can remove it.')}</p>
      {error && <div className="form-error">{error}</div>}

      <div
        className={`emoji-drop${over ? ' over' : ''}`}
        onDragOver={(e) => { e.preventDefault(); setOver(true) }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => { e.preventDefault(); setOver(false); pick(e.dataTransfer.files) }}
      >
        <Icon name="smile" size={20} />
        <div>
          <b>{t('Add emoji')}</b>
          <span>{t('Drop pictures here, or choose several at once. Each is named after its file. PNG, GIF, WebP, JPEG or SVG, up to 512 KB; square works best.')}</span>
        </div>
        <button type="button" className="studio-btn primary" onClick={() => input.current?.click()} data-emoji-choose="1"><Icon name="plus" size={14} /> {t('Choose files')}</button>
        <input ref={input} type="file" multiple accept={TYPES.join(',') + ',.svg'} hidden onChange={(e) => { pick(e.target.files); e.target.value = '' }} data-emoji-input="1" />
      </div>

      {pending.length > 0 && (
        <div className="emoji-pending" role="list" aria-label={t('To add')}>
          {pending.map((p, i) => {
            const why = problem(p, pending)
            return (
              <div key={i} role="listitem" className={`emoji-pending-row ${p.state}${why && p.state === 'ready' ? ' bad' : ''}`}>
                <img src={p.preview} alt="" />
                <label className="emoji-name-field">
                  <span>:</span>
                  <input value={p.name} disabled={p.state !== 'ready'} aria-label={t('Name')} onChange={(e) => { const name = emojiNameFrom(e.target.value); setPending((all) => all.map((x, j) => (j === i ? { ...x, name } : x))) }} />
                  <span>:</span>
                </label>
                <span className="emoji-pending-state">
                  {p.state === 'added' ? <><Icon name="check" size={13} /> {t('Added')}</> : p.state === 'adding' ? t('Adding…') : why}
                </span>
                {p.state !== 'adding' && p.state !== 'added' && (
                  <button type="button" className="studio-icon-btn" aria-label={t('Remove')} onClick={() => setPending((all) => all.filter((_, j) => j !== i))}><Icon name="x" size={14} /></button>
                )}
              </div>
            )
          })}
          <div className="emoji-pending-go">
            <button type="button" className="studio-btn" onClick={() => setPending([])} disabled={busy}>{t('Clear')}</button>
            <button type="button" className="studio-btn primary" onClick={() => void addAll()} disabled={busy || !ready.length} data-emoji-add="1">
              {busy ? t('Adding…') : t('Add {n}', { n: ready.length })}
            </button>
          </div>
        </div>
      )}

      <div className="studio-section-head">
        <div>
          <h2>{t('In this workspace')} <span className="emoji-count">{list.length}</span></h2>
        </div>
      </div>
      {list.length > 6 && (
        <label className="studio-search">
          <Icon name="search" size={15} />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder={t('Find an emoji')} aria-label={t('Find an emoji')} />
        </label>
      )}
      {list.length === 0 ? (
        <p className="studio-empty">{t('None yet. The first one you add is everyone’s here.')}</p>
      ) : (
        <div className="emoji-grid" role="list">
          {shown.map((e) => (
            <div key={e.name} className="emoji-tile" role="listitem" data-emoji={e.name}>
              <img src={e.url} alt={`:${e.name}:`} loading="lazy" />
              <span className="emoji-tile-name">:{e.name}:</span>
              <button type="button" className="studio-icon-btn emoji-tile-remove" onClick={() => void remove(e.name)} aria-label={t('Remove :{name}:', { name: e.name })}><Icon name="trash" size={13} /></button>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
