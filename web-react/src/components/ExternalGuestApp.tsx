import React, { useCallback, useEffect, useState } from 'react'
import './ExternalGuestApp.css'

interface AppMeta { id: string; name: string; description: string; icon: string | null; tableId: string; permission: 'view' | 'edit' }
interface AppColumn { id: string; name: string; type: string }
interface AppRow { id: string; data: Record<string, unknown>; createdAt: string; updatedAt: string }
interface AppMessage { sequence: number; body: string; createdAt: string; authorName: string; mine: boolean }

export function ExternalGuestApp({ httpBase, orgId, appId, sessionToken, onExit }: {
  httpBase: string; orgId: string; appId: string; sessionToken: string; onExit?: () => void
}) {
  const [app, setApp] = useState<AppMeta | null>(null)
  const [columns, setColumns] = useState<AppColumn[]>([])
  const [rows, setRows] = useState<AppRow[]>([])
  const [messages, setMessages] = useState<AppMessage[]>([])
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const base = `${httpBase}/external/apps/${encodeURIComponent(orgId)}/${encodeURIComponent(appId)}`
  const headers = { 'x-session-token': sessionToken, 'content-type': 'application/json' }
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
        const [tableResponse, conversationResponse] = await Promise.all([
          fetch(`${base}/tables/${encodeURIComponent(metadata.tableId)}/rows?limit=50`, { headers: { 'x-session-token': sessionToken }, signal: controller.signal }),
          fetch(`${base}/conversation`, { headers: { 'x-session-token': sessionToken }, signal: controller.signal }),
        ])
        const [tableData, conversationData] = await Promise.all([tableResponse.json(), conversationResponse.json()])
        if (!tableResponse.ok || !conversationResponse.ok) throw new Error(tableData.message || conversationData.message || 'Could not load the shared App.')
        if (!controller.signal.aborted) {
          setColumns(tableData.table?.columns || [])
          setRows(tableData.rows || [])
          setMessages(conversationData.messages || [])
        }
      })
      .catch(reason => { if (!controller.signal.aborted) setError(reason instanceof Error ? reason.message : String(reason)) })
    return () => controller.abort()
  }, [base, sessionToken])
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
  return <main className="external-app-guest">
    <header className="external-app-guest__header">
      <button type="button" className="external-app-guest__back" onClick={onExit || (() => { location.hash = '#/feed' })}>← Back</button>
      <div><span className="external-app-guest__eyebrow">Shared App</span><h1>{app?.icon ? <span aria-hidden="true">{app.icon} </span> : null}{app?.name || 'Opening shared App…'}</h1>{app?.description && <p>{app.description}</p>}</div>
      {app && <span className="external-app-guest__permission">{app.permission === 'edit' ? 'Can edit' : 'View only'}</span>}
    </header>
    {error && <div className="external-app-guest__error" role="alert">{error}</div>}
    {notice && <div className="external-app-guest__notice" role="status">{notice}</div>}
    <section className="external-app-guest__panel" aria-label="App records">
      <div className="external-app-guest__section-title"><div><span className="external-app-guest__eyebrow">Linked data</span><h2>{columns.length ? 'Records' : 'Loading records'}</h2></div><span>{rows.length} shown</span></div>
      {rows.length ? <div className="external-app-guest__table-wrap"><table><thead><tr>{columns.map(column => <th key={column.id}>{column.name}</th>)}</tr></thead><tbody>{rows.map(row => <tr key={row.id}>{columns.map(column => <td key={column.id}>{String(row.data?.[column.id] ?? '—')}</td>)}</tr>)}</tbody></table></div> : <p className="external-app-guest__empty">{app ? 'No records are available in this App yet.' : 'Loading…'}</p>}
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
