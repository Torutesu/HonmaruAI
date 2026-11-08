import React, { useCallback, useEffect, useState } from 'react'
import './ExternalGuestApp.css'

interface AppMeta { id: string; name: string; description: string; icon: string | null; tableId: string; permission: 'view' | 'edit' }
interface AppColumn { id: string; name: string; type: string; options?: string[] }
interface AppTable { id: string; name: string; columns: AppColumn[] }
interface AppRow { id: string; data: Record<string, unknown>; createdAt: string; updatedAt: string }
interface AppMessage { sequence: number; body: string; createdAt: string; authorName: string; mine: boolean }

export function ExternalGuestApp({ httpBase, orgId, appId, sessionToken, onExit }: {
  httpBase: string; orgId: string; appId: string; sessionToken: string; onExit?: () => void
}) {
  const [app, setApp] = useState<AppMeta | null>(null)
  const [tables, setTables] = useState<AppTable[]>([])
  const [activeTableId, setActiveTableId] = useState('')
  const [rows, setRows] = useState<AppRow[]>([])
  const [hasMoreRows, setHasMoreRows] = useState(false)
  const [loadingMoreRows, setLoadingMoreRows] = useState(false)
  const [messages, setMessages] = useState<AppMessage[]>([])
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState<Record<string, unknown>>({})
  const [editing, setEditing] = useState<AppRow | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const base = `${httpBase}/external/apps/${encodeURIComponent(orgId)}/${encodeURIComponent(appId)}`
  const headers = { 'x-session-token': sessionToken, 'content-type': 'application/json' }
  const rowsUrl = useCallback((tableId: string, offset = 0) => `${base}/tables/${encodeURIComponent(tableId)}/rows?limit=51&offset=${offset}`, [base])
  const loadRows = useCallback(async (tableId: string) => {
    if (!tableId) return
    const response = await fetch(rowsUrl(tableId), { headers: { 'x-session-token': sessionToken } })
    const data = await response.json()
    if (!response.ok) throw new Error(data.message || String(response.status))
    const page = Array.isArray(data.rows) ? data.rows : []
    setRows(page.slice(0, 50))
    setHasMoreRows(page.length > 50)
  }, [rowsUrl, sessionToken])
  const loadMoreRows = async () => {
    if (!activeTableId || loadingMoreRows || !hasMoreRows) return
    setLoadingMoreRows(true)
    try {
      const response = await fetch(rowsUrl(activeTableId, rows.length), { headers: { 'x-session-token': sessionToken } })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || String(response.status))
      const page = Array.isArray(data.rows) ? data.rows : []
      setRows(current => [...current, ...page.slice(0, 50)])
      setHasMoreRows(page.length > 50)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setLoadingMoreRows(false) }
  }
  const loadConversation = useCallback(async () => {
    const response = await fetch(`${base}/conversation`, { headers: { 'x-session-token': sessionToken } })
    const data = await response.json()
    if (!response.ok) throw new Error(data.message || String(response.status))
    setMessages(data.messages || [])
  }, [base, sessionToken])
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    fetch(base, { headers: { 'x-session-token': sessionToken }, signal: controller.signal })
      .then(async response => { const data = await response.json(); if (!response.ok) throw new Error(data.message || String(response.status)); return data.app as AppMeta })
      .then(async metadata => {
        if (controller.signal.aborted) return
        setApp(metadata)
        const [tableResponse, tablesResponse, conversationResponse] = await Promise.all([
          fetch(rowsUrl(metadata.tableId), { headers: { 'x-session-token': sessionToken }, signal: controller.signal }),
          fetch(`${base}/tables`, { headers: { 'x-session-token': sessionToken }, signal: controller.signal }),
          fetch(`${base}/conversation`, { headers: { 'x-session-token': sessionToken }, signal: controller.signal }),
        ])
        const [tableData, tablesData, conversationData] = await Promise.all([tableResponse.json(), tablesResponse.json(), conversationResponse.json()])
        if (!tableResponse.ok || !tablesResponse.ok || !conversationResponse.ok) throw new Error(tableData.message || tablesData.message || conversationData.message || 'Could not load the shared App.')
        if (!controller.signal.aborted) {
          setTables(tablesData.tables || [])
          setActiveTableId(metadata.tableId)
          const page = Array.isArray(tableData.rows) ? tableData.rows : []
          setRows(page.slice(0, 50))
          setHasMoreRows(page.length > 50)
          setMessages(conversationData.messages || [])
        }
      })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => controller.abort()
  }, [base, sessionToken, rowsUrl])
  const selectTable = async (tableId: string) => {
    setActiveTableId(tableId); setRows([]); setHasMoreRows(false); setError('')
    try { await loadRows(tableId) } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
  }
  const saveRow = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!app || !activeTableId) return
    setBusy(true); setError('')
    try {
      const target = editing
        ? `${base}/tables/${encodeURIComponent(activeTableId)}/rows/${encodeURIComponent(editing.id)}`
        : `${base}/tables/${encodeURIComponent(activeTableId)}/rows`
      const response = await fetch(target, {
        method: editing ? 'PATCH' : 'POST', headers,
        body: JSON.stringify({ values: draft, ...(editing ? { expectedUpdatedAt: editing.updatedAt } : {}) }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || String(response.status))
      setEditing(null); setDraft({})
      await loadRows(activeTableId)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const removeRow = async (row: AppRow) => {
    if (!activeTableId || !window.confirm('Delete this record?')) return
    setBusy(true); setError('')
    try {
      const response = await fetch(`${base}/tables/${encodeURIComponent(activeTableId)}/rows/${encodeURIComponent(row.id)}`, {
        method: 'DELETE', headers, body: JSON.stringify({ expectedUpdatedAt: row.updatedAt }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || String(response.status))
      await loadRows(activeTableId)
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const send = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!app || !body.trim()) return
    setBusy(true); setError(''); setNotice('')
    try {
      const response = await fetch(`${base}/conversation`, {
        method: 'POST', headers,
        body: JSON.stringify(app.permission === 'view'
          ? { body: body.trim(), requestSend: true }
          : { body: body.trim(), requestId: `guest_${crypto.randomUUID()}` }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.message || String(response.status))
      setBody('')
      if (app.permission === 'view') setNotice('Your message is waiting for App owner approval.')
      else await loadConversation()
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)) }
    finally { setBusy(false) }
  }
  const inputFor = (column: AppColumn) => {
    const value = draft[column.id]
    if (column.type === 'checkbox') return <input type="checkbox" checked={Boolean(value)} onChange={event => setDraft(current => ({ ...current, [column.id]: event.target.checked }))} />
    if (column.type === 'select') return <select value={String(value ?? '')} onChange={event => setDraft(current => ({ ...current, [column.id]: event.target.value || null }))}><option value="">—</option>{(column.options || []).map(option => <option key={option} value={option}>{option}</option>)}</select>
    const type = column.type === 'number' ? 'number' : column.type === 'date' ? 'date' : column.type === 'email' ? 'email' : column.type === 'url' ? 'url' : 'text'
    return <input type={type} value={String(value ?? '')} onChange={event => setDraft(current => ({ ...current, [column.id]: event.target.value === '' ? null : column.type === 'number' ? Number(event.target.value) : event.target.value }))} />
  }
  const activeTable = tables.find(table => table.id === activeTableId)
  return <main className="external-app-guest">
    <header className="external-app-guest__header">
      <button type="button" className="external-app-guest__back" onClick={onExit || (() => { location.hash = '#/feed' })}>← Back</button>
      <div><span className="external-app-guest__eyebrow">Shared App</span><h1>{app?.icon ? <span aria-hidden="true">{app.icon} </span> : null}{app?.name || 'Opening shared App…'}</h1>{app?.description && <p>{app.description}</p>}</div>
      {app && <span className="external-app-guest__permission">{app.permission === 'edit' ? 'Can edit' : 'View only'}</span>}
    </header>
    {error && <div className="external-app-guest__error" role="alert">{error}</div>}
    {notice && <div className="external-app-guest__notice" role="status">{notice}</div>}
    <section className="external-app-guest__panel" aria-label="App records">
      <div className="external-app-guest__section-title"><div><span className="external-app-guest__eyebrow">Linked data</span><h2>{activeTable?.name || (app ? 'Records' : 'Loading records')}</h2></div><span>{rows.length} shown</span></div>
      <div className="external-app-guest__table-tools">
        {tables.length > 1 && <label>Table<select aria-label="App table" value={activeTableId} onChange={event => void selectTable(event.target.value)}>{tables.map(table => <option key={table.id} value={table.id}>{table.name}</option>)}</select></label>}
        {app?.permission === 'edit' && !editing && <button type="button" disabled={busy} onClick={() => { setDraft({}); setEditing({ id: '', data: {}, createdAt: '', updatedAt: '' }) }}>Add record</button>}
      </div>
      {rows.length ? <div className="external-app-guest__table-wrap"><table><thead><tr>{activeTable?.columns.map(column => <th key={column.id}>{column.name}</th>)}{app?.permission === 'edit' && <th>Actions</th>}</tr></thead><tbody>{rows.map(row => <tr key={row.id}>{activeTable?.columns.map(column => <td key={column.id}>{String(row.data?.[column.id] ?? '—')}</td>)}{app?.permission === 'edit' && <td className="external-app-guest__row-actions"><button type="button" disabled={busy} onClick={() => { setEditing(row); setDraft({ ...row.data }) }}>Edit</button><button type="button" disabled={busy} onClick={() => void removeRow(row)}>Delete</button></td>}</tr>)}</tbody></table></div> : <p className="external-app-guest__empty">{app ? 'No records are available in this App yet.' : 'Loading…'}</p>}
      {hasMoreRows && <div className="external-app-guest__pagination"><button type="button" disabled={loadingMoreRows || busy} onClick={() => void loadMoreRows()}>{loadingMoreRows ? 'Loading…' : 'Load more records'}</button></div>}
      {app?.permission === 'edit' && editing && <form className="external-app-guest__row-form" onSubmit={saveRow}>
        <h3>{editing.id ? 'Edit record' : 'New record'}</h3>
        {activeTable?.columns.map(column => <label key={column.id}>{column.name}{inputFor(column)}</label>)}
        <div><button type="submit" disabled={busy}>{editing.id ? 'Save record' : 'Create record'}</button><button type="button" disabled={busy} onClick={() => { setEditing(null); setDraft({}) }}>Cancel</button></div>
      </form>}
    </section>
    <section className="external-app-guest__panel" aria-label="App conversation">
      <div className="external-app-guest__section-title"><div><span className="external-app-guest__eyebrow">Conversation</span><h2>App discussion</h2></div></div>
      <ol className="external-app-guest__messages">{messages.map(message => <li key={message.sequence}><strong>{message.mine ? 'You' : message.authorName}</strong><p>{message.body}</p></li>)}</ol>
      <form className="external-app-guest__composer" onSubmit={send}>
        <label htmlFor="external-app-message">{app?.permission === 'edit' ? 'Add a message' : 'Request to send a message'}</label>
        <textarea id="external-app-message" maxLength={4000} value={body} onChange={event => setBody(event.target.value)} disabled={!app || busy} />
        <button type="submit" disabled={!app || busy || !body.trim()}>{app?.permission === 'view' ? 'Request owner approval' : 'Send message'}</button>
      </form>
    </section>
  </main>
}
