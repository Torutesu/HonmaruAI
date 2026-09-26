import React, { useCallback, useEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { aiHeaders } from '../utils/aiKey'
import { Markdown } from '../utils/markdown'
import { Icon } from './Icon'

// The canvas: one shared document per conversation — how things are done,
// what was decided, who owns what — that anyone in it reads and edits, as
// Slack's channel canvas and Ando's Channel Context.
//
// A save names the version it was made from; if somebody saved in between,
// the Worker refuses and hands theirs back, and this says so rather than
// writing over it. To-dos ("- [ ]") tick straight from the page.

interface Canvas { body: string; version: number; updatedBy: string | null; updatedAt: string | null }
interface Revision { version: number; updatedBy: string | null; updatedAt: string; size: number }
interface Api { httpBase: string; orgId: string; sessionToken: string }

const TASK = /^(\s*[-*]\s+)\[( |x|X)\](\s+.*)$/

/// The body in runs: to-do lines on their own, everything else as Markdown.
export function canvasRuns(body: string): Array<{ kind: 'md'; text: string } | { kind: 'task'; line: number; done: boolean; text: string }> {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const out: Array<{ kind: 'md'; text: string } | { kind: 'task'; line: number; done: boolean; text: string }> = []
  let md: string[] = []
  const flush = () => { if (md.join('').trim()) out.push({ kind: 'md', text: md.join('\n') }); md = [] }
  lines.forEach((line, i) => {
    const m = line.match(TASK)
    if (m) { flush(); out.push({ kind: 'task', line: i, done: m[2].toLowerCase() === 'x', text: m[3].trim() }) } else md.push(line)
  })
  flush()
  return out
}

/// The body with one to-do ticked or unticked.
export function toggleTask(body: string, line: number): string {
  const lines = body.replace(/\r\n?/g, '\n').split('\n')
  const m = lines[line]?.match(TASK)
  if (!m) return body
  lines[line] = `${m[1]}[${m[2] === ' ' ? 'x' : ' '}]${m[3]}`
  return lines.join('\n')
}

const STARTER = (t: (k: string) => string) => `## ${t('What this channel is for')}\n\n## ${t('How we do things')}\n- \n\n## ${t('Decided')}\n- \n\n## ${t('Open')}\n- [ ] `

export const ChannelCanvas: React.FC<{ api: Api; headers: Record<string, string>; view: string; title: string; onClose: () => void }> = ({ api, headers, view, title, onClose }) => {
  const t = useT()
  const [canvas, setCanvas] = useState<Canvas | null>(null)
  const [revisions, setRevisions] = useState<Revision[]>([])
  const [editing, setEditing] = useState<string | null>(null)
  const [base, setBase] = useState(0)
  const [busy, setBusy] = useState<null | 'save' | 'ai' | 'history'>(null)
  const [note, setNote] = useState<string | null>(null)
  const [conflict, setConflict] = useState<Canvas | null>(null)
  const [changedBy, setChangedBy] = useState<string | null>(null)
  const [history, setHistory] = useState(false)
  const [viewing, setViewing] = useState<Canvas | null>(null)
  const editingRef = useRef<string | null>(null)
  editingRef.current = editing

  const q = useCallback((extra: Record<string, string> = {}) => new URLSearchParams({ orgId: api.orgId, channel: view, ...extra }).toString(), [api.orgId, view])
  const load = useCallback(async () => {
    const res = await fetch(`${api.httpBase}/channels/canvas?${q()}`, { headers }).catch(() => null)
    const data = res?.ok ? await res.json().catch(() => null) : null
    if (!data) { setNote(t('The canvas did not load. Try again.')); return }
    setCanvas(data.canvas); setRevisions(data.revisions || []); setChangedBy(null)
  }, [api.httpBase, headers, q, t])
  useEffect(() => { setCanvas(null); setEditing(null); setConflict(null); setHistory(false); setViewing(null); void load() }, [load])

  // Somebody else saved: reload, unless you are in the middle of an edit —
  // then say so, and your save will be told about theirs.
  useEffect(() => {
    const on = (e: Event) => {
      const { name, value } = (e as CustomEvent<{ name: string; value: any }>).detail || {}
      if (name !== 'channel_canvas' || value?.channel !== view) return
      if (editingRef.current !== null) setChangedBy(value.updatedBy || t('someone'))
      else void load()
    }
    window.addEventListener('honmaru:jam', on)
    return () => window.removeEventListener('honmaru:jam', on)
  }, [view, load, t])

  const put = async (body: string, baseVersion: number) => {
    const res = await fetch(`${api.httpBase}/channels/canvas`, {
      method: 'PUT', headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ orgId: api.orgId, channel: view, body, baseVersion }),
    })
    const data = await res.json().catch(() => ({}))
    return { res, data }
  }

  const save = async () => {
    if (editing === null) return
    setBusy('save'); setNote(null)
    try {
      const { res, data } = await put(editing, base)
      if (res.status === 409) { setConflict(data.canvas); return }
      if (!res.ok) { setNote(data.message || t('That did not save.')); return }
      setCanvas(data.canvas); setRevisions(data.revisions || []); setEditing(null); setConflict(null); setChangedBy(null)
    } finally { setBusy(null) }
  }

  const tick = async (line: number) => {
    if (!canvas) return
    const next = toggleTask(canvas.body, line)
    setCanvas({ ...canvas, body: next })
    const { res, data } = await put(next, canvas.version)
    if (res.ok) { setCanvas(data.canvas); setRevisions(data.revisions || []) } else { void load(); if (res.status === 409) setNote(t('Someone else changed the canvas just now. Here is theirs.')) }
  }

  const askAI = async () => {
    setBusy('ai'); setNote(null)
    try {
      const res = await fetch(`${api.httpBase}/channels/canvas/draft`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json', ...aiHeaders() },
        body: JSON.stringify({ orgId: api.orgId, channel: view, body: editing ?? canvas?.body ?? '' }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setNote(data.message || t('That did not work. Try again in a moment.')); return }
      if (data.byModel) {
        if (editing === null) setBase(canvas?.version || 0)
        setEditing(data.body)
      }
      setNote(data.note || null)
    } finally { setBusy(null) }
  }

  const openRevision = async (version: number) => {
    setBusy('history')
    try {
      const res = await fetch(`${api.httpBase}/channels/canvas/revision?${q({ version: String(version) })}`, { headers })
      const data = await res.json().catch(() => ({}))
      if (res.ok) setViewing(data.revision)
    } finally { setBusy(null) }
  }

  const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) : '')
  const startEdit = (text?: string) => { setBase(canvas?.version || 0); setEditing(text ?? (canvas?.body || STARTER(t))); setConflict(null); setNote(null) }

  return (
    <aside className="slk-pane slk-canvas" aria-label={t('Canvas')} data-canvas={view}>
      <header className="slk-pane-head">
        <button className="slk-back pane" onClick={onClose} aria-label={t('Back')}><span aria-hidden="true">‹</span></button>
        <h2>{t('Canvas · {name}', { name: title })}</h2>
        <button type="button" className={`slk-pane-tool${history ? ' on' : ''}`} onClick={() => { setHistory((h) => !h); setViewing(null) }} aria-label={t('Earlier versions')} title={t('Earlier versions')} data-canvas-history="1">
          <Icon name="clock" size={15} />
        </button>
        <button className="slk-pane-close" onClick={onClose} aria-label={t('Close')}><Icon name="x" size={16} /></button>
      </header>
      <div className="slk-pane-body slk-canvas-body">
        {canvas === null && !note && <p className="slk-empty" role="status">{t('Loading…')}</p>}
        {note && <p className="slk-canvas-note" role="status">{note}</p>}

        {history && (
          <div className="slk-canvas-history">
            {revisions.length === 0 && <p className="slk-empty">{t('No earlier versions yet.')}</p>}
            {revisions.map((r) => (
              <button key={r.version} type="button" className={`slk-canvas-rev${viewing?.version === r.version ? ' on' : ''}`} onClick={() => void openRevision(r.version)} data-rev={r.version}>
                <b>{t('Version {n}', { n: r.version })}</b>
                <span>{r.updatedBy || t('someone')} · {when(r.updatedAt)}</span>
              </button>
            ))}
            {viewing && (
              <div className="slk-canvas-preview">
                <Markdown source={viewing.body} className="slk-canvas-doc" />
                {canvas && viewing.version !== canvas.version && (
                  <button type="button" className="pill-btn" onClick={() => { setHistory(false); startEdit(viewing.body) }} data-rev-restore="1">{t('Put this version back')}</button>
                )}
              </div>
            )}
          </div>
        )}

        {!history && canvas && editing === null && (
          <>
            {canvas.body.trim()
              ? (
                <div className="slk-canvas-doc">
                  {canvasRuns(canvas.body).map((run, i) => run.kind === 'md'
                    ? <Markdown key={i} source={run.text} />
                    : (
                      <label key={i} className={`slk-canvas-task${run.done ? ' done' : ''}`}>
                        <input type="checkbox" checked={run.done} onChange={() => void tick(run.line)} data-task={run.line} />
                        <span>{run.text}</span>
                      </label>
                    ))}
                </div>
              )
              : (
                <div className="slk-canvas-empty">
                  <p>{t('canvas.empty')}</p>
                  <button type="button" className="pill-btn" onClick={() => startEdit()} data-canvas-start="1">{t('Start the canvas')}</button>
                </div>
              )}
            <div className="slk-canvas-actions">
              {canvas.body.trim() && <button type="button" className="pill-btn" onClick={() => startEdit()} data-canvas-edit="1"><Icon name="edit" size={13} /> {t('Edit')}</button>}
              <button type="button" className="btn-text" disabled={busy === 'ai'} onClick={() => void askAI()} data-canvas-ai="1">
                <Icon name="sparkle" size={13} /> {busy === 'ai' ? t('Reading the conversation…') : t('Update from the conversation')}
              </button>
            </div>
            {canvas.version > 0 && <p className="slk-canvas-meta">{t('Edited by {name} · {when}', { name: canvas.updatedBy || t('someone'), when: when(canvas.updatedAt) })}</p>}
          </>
        )}

        {!history && editing !== null && (
          <div className="slk-canvas-editor">
            {changedBy && !conflict && <p className="slk-canvas-note warn" role="status">{t('{name} just saved the canvas. Saving yours will ask what to keep.', { name: changedBy })}</p>}
            {conflict && (
              <div className="slk-canvas-conflict" role="alert">
                <p>{t('{name} changed the canvas while you were editing.', { name: conflict.updatedBy || t('Someone') })}</p>
                <div className="slk-canvas-conflict-actions">
                  <button type="button" className="pill-btn" onClick={() => { setBase(conflict.version); setConflict(null); setChangedBy(null) }} data-conflict-mine="1">{t('Keep mine')}</button>
                  <button type="button" className="btn-text" onClick={() => { setCanvas(conflict); setEditing(null); setConflict(null); setChangedBy(null) }}>{t('Use theirs')}</button>
                  <button type="button" className="btn-text" onClick={() => { setBase(conflict.version); setEditing(`${conflict.body}\n\n${editing}`); setConflict(null); setChangedBy(null) }}>{t('Put both together')}</button>
                </div>
              </div>
            )}
            <textarea
              value={editing} onChange={(e) => setEditing(e.target.value)} aria-label={t('Canvas')} data-canvas-text="1"
              onKeyDown={(e) => { if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); void save() } }}
              spellCheck
            />
            <p className="slk-canvas-hint">{t('canvas.syntax')}</p>
            <div className="slk-canvas-actions">
              <button type="button" className="pill-btn" disabled={busy === 'save'} onClick={() => void save()} data-canvas-save="1">{busy === 'save' ? t('Saving…') : t('Save')}</button>
              <button type="button" className="btn-text" onClick={() => { setEditing(null); setConflict(null); setChangedBy(null); setNote(null); if (changedBy) void load() }}>{t('Cancel')}</button>
              <span style={{ flex: 1 }} />
              <button type="button" className="btn-text" disabled={busy === 'ai'} onClick={() => void askAI()}>
                <Icon name="sparkle" size={13} /> {busy === 'ai' ? t('Reading the conversation…') : t('Update from the conversation')}
              </button>
            </div>
          </div>
        )}
      </div>
    </aside>
  )
}
