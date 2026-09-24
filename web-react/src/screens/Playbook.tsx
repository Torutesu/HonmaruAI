import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { useT } from '../utils/i18n'
import { getLocale } from '../utils/locale'
import { hashForCard } from '../utils/route'

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
  onClose: () => void
}

interface Memory {
  id: string
  text: string
  /// Learned from a decision and its reason, or written by a person.
  origin: 'learned' | 'told'
  cardId: string | null
  /// Who wrote it, by name; null for a rule the AI learned, or whoever left.
  createdByName: string | null
  mine?: boolean
  createdAt: string
  updatedAt: string
  canEdit: boolean
}

const MAX_RULE = 280

/// The playbook: the rules your AI follows when it routes, answers and
/// writes. Most of them it learned from the reasons people gave when they
/// decided; some somebody wrote down. All of them can be read, corrected and
/// deleted here — an assistant that learns things you cannot see is one you
/// cannot trust with the next decision.
export const Playbook: React.FC<Props> = ({ httpBase, orgId, sessionToken, onClose }) => {
  const t = useT()
  const [memories, setMemories] = useState<Memory[] | null>(null)
  const [canForget, setCanForget] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [draft, setDraft] = useState('')
  const [adding, setAdding] = useState(false)
  const [editing, setEditing] = useState<{ id: string; text: string } | null>(null)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)

  const headers = useMemo(() => ({ 'content-type': 'application/json', 'x-session-token': sessionToken }), [sessionToken])
  const load = useCallback(async () => {
    try {
      const res = await fetch(`${httpBase}/memories?orgId=${encodeURIComponent(orgId)}`, { headers: { 'x-session-token': sessionToken } })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || t('Could not load the playbook.'))
      setMemories(data.memories || [])
      setCanForget(Boolean(data.canForget))
    } catch (err) {
      setMemories([])
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [httpBase, orgId, sessionToken, t])
  useEffect(() => { load() }, [load])

  const act = async (key: string, work: () => Promise<void>) => {
    setBusy(key); setError(null); setNote(null)
    try { await work() } catch (err) { setError(err instanceof Error ? err.message : String(err)) } finally { setBusy(null) }
  }
  const send = async (method: string, path: string, body?: Record<string, unknown>) => {
    const res = await fetch(`${httpBase}${path}`, { method, headers, body: body ? JSON.stringify({ orgId, ...body }) : undefined })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.message || t('That did not save.'))
    return data
  }

  const add = () => {
    const text = draft.trim()
    if (!text) return
    setAdding(true)
    act('add', async () => {
      const data = await send('POST', '/memories', { text })
      setMemories((list) => [data.memory, ...(list || [])])
      setDraft('')
    }).finally(() => setAdding(false))
  }
  const save = (id: string, text: string) => act(id, async () => {
    const data = await send('PUT', `/memories/${encodeURIComponent(id)}`, { text: text.trim() })
    setMemories((list) => (list || []).map((m) => (m.id === id ? data.memory : m)))
    setEditing(null)
  })
  const remove = (id: string) => act(id, async () => {
    await send('DELETE', `/memories/${encodeURIComponent(id)}?orgId=${encodeURIComponent(orgId)}`)
    setMemories((list) => (list || []).filter((m) => m.id !== id))
    setConfirm(null)
  })
  const forgetLearned = () => act('forget', async () => {
    const data = await send('DELETE', `/memories?orgId=${encodeURIComponent(orgId)}&learned=1`)
    setMemories((list) => (list || []).filter((m) => m.origin !== 'learned'))
    setConfirm(null)
    setNote(t('Forgot {n} learned rules.', { n: Number(data.removed || 0) }))
  })

  const learned = (memories || []).filter((m) => m.origin === 'learned').length
  const date = (iso: string) => new Date(iso).toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' })

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="back" onClick={onClose} aria-label={t('Close')}>‹</button>
        <span className="head-title">{t('Playbook')}</span>
      </div>
      <div className="screen-body">
        <p className="lede" style={{ marginTop: 8 }}>
          {t('Rules your AI follows when it routes, answers and writes. It learns them from the reasons you give when you decide.')}
        </p>

        <div className="rows">
          <div className="row static playbook-add">
            <span className="row-main">
              {t('Tell it a rule')}
              <textarea
                className="context-input playbook-input"
                rows={2}
                value={draft}
                maxLength={MAX_RULE}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); add() } }}
                placeholder={t('e.g. Anything over $1,000 goes to Kenji first.')}
                aria-label={t('Tell it a rule')}
              />
              <span className="playbook-add-foot">
                <span className="row-sub">{draft.length > MAX_RULE - 40 ? `${draft.length}/${MAX_RULE}` : ''}</span>
                <button className="pill-btn" onClick={add} disabled={adding || !draft.trim()}>{t('Add')}</button>
              </span>
            </span>
          </div>
        </div>

        {note && <div className="form-note">{note}</div>}
        {error && <div className="form-error">{error}</div>}

        <div className="rows-title">{t('What it follows')}</div>
        {memories === null && <div className="empty">{t('Loading…')}</div>}
        {memories !== null && memories.length === 0 && (
          <div className="empty">{t('No rules yet. Give a reason when you decline or revise a card, and your AI writes one down here.')}</div>
        )}
        {memories !== null && memories.length > 0 && (
          <div className="rows">
            {memories.map((m) => (
              <div className="row static memory-row" key={m.id} data-memory={m.id}>
                <span className="row-main">
                  {editing?.id === m.id ? (
                    <>
                      <textarea
                        className="context-input playbook-input"
                        rows={2}
                        value={editing.text}
                        maxLength={MAX_RULE}
                        autoFocus
                        onChange={(e) => setEditing({ id: m.id, text: e.target.value })}
                        aria-label={t('Rule')}
                      />
                      <span className="playbook-add-foot">
                        <span />
                        <span className="team-confirm">
                          <button className="btn-text" onClick={() => setEditing(null)}>{t('Cancel')}</button>
                          <button className="pill-btn" disabled={busy === m.id || !editing.text.trim()} onClick={() => save(m.id, editing.text)}>{t('Save')}</button>
                        </span>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="memory-text">{m.text}</span>
                      <span className="row-sub">
                        {m.origin === 'learned'
                          ? (m.cardId ? <a className="memory-source" href={hashForCard(m.cardId)}>{t('Learned from a decision')}</a> : t('Learned from a decision'))
                          : (m.mine ? t('Written by you') : t('Written by {name}', { name: m.createdByName || t('a teammate') }))}
                        {` · ${date(m.updatedAt || m.createdAt)}`}
                      </span>
                      {m.canEdit && (
                        <span className="routine-actions">
                          {confirm === m.id ? (
                            <span className="team-confirm">
                              <span className="routine-ask">{t('Delete this rule?')}</span>
                              <button className="pill-btn" disabled={busy === m.id} onClick={() => remove(m.id)}>{t('Delete')}</button>
                              <button className="btn-text" onClick={() => setConfirm(null)}>{t('Keep')}</button>
                            </span>
                          ) : (
                            <>
                              <button className="btn-text" onClick={() => { setConfirm(null); setEditing({ id: m.id, text: m.text }) }}>{t('Edit')}</button>
                              <button className="btn-text danger" onClick={() => { setEditing(null); setConfirm(m.id) }}>{t('Delete')}</button>
                            </>
                          )}
                        </span>
                      )}
                    </>
                  )}
                </span>
              </div>
            ))}
          </div>
        )}

        {canForget && learned > 0 && (
          <>
            <div className="rows">
              <button className="row" onClick={() => setConfirm(confirm === 'forget' ? null : 'forget')}>
                <span className="row-main" style={{ color: '#a11258' }}>
                  {t('Forget everything learned')}
                  <span className="row-sub">{t('Rules people wrote stay. Only an admin can do this.')}</span>
                </span>
              </button>
            </div>
            {confirm === 'forget' && (
              <div className="form-error">
                {t('Your AI forgets the {n} rules it learned from decisions. This cannot be undone.', { n: learned })}
                <div style={{ display: 'flex', gap: 8, marginTop: 10 }}>
                  <button className="btn btn-ghost" onClick={() => setConfirm(null)}>{t('Keep them')}</button>
                  <button className="btn btn-primary" disabled={busy === 'forget'} onClick={forgetLearned}>{t('Forget')}</button>
                </div>
              </div>
            )}
          </>
        )}
        <div style={{ height: 24 }} />
      </div>
    </div>
  )
}
