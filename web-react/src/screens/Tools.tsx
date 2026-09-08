import React, { useCallback, useEffect, useState, useRef } from 'react'
import { GitBranch, Mail, MessageSquare, Notebook } from 'lucide-react'
import { readResponse } from '../utils/api'
import { useT } from '../utils/i18n'

interface Connector { id: string; label: string; status: string }

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
  onClose: () => void
}

// English keys, translated where they are read — see utils/i18n.
const BLURB: Record<string, string> = {
  gmail: 'Mail that needs a decision becomes a card. Nothing else does.',
  slack: 'Messages addressed to you, triaged into decisions — without you opening Slack.',
  notion: 'Decisions are written back to the database you point at.',
  github: 'Approvals, tasks and assignee changes sync to Issues and Pull Requests.',
}
const ICON: Record<string, React.ElementType> = { gmail: Mail, slack: MessageSquare, notion: Notebook, github: GitBranch }

/// Your tools, connected — and deliberately not as channels.
///
/// Every connector here is an *input*: it produces decisions in the feed. None
/// of them puts a Slack channel or a Notion sidebar inside this app, because
/// the point of the product is that you stopped going to those places.
export const Tools: React.FC<Props> = ({ httpBase, orgId, sessionToken, onClose }) => {
  const t = useT()
  const live = useRef(true)
  useEffect(() => { live.current=true; return () => { live.current=false } }, [])
  const [notionReady,setNotionReady] = useState(false)
  const [connectors, setConnectors] = useState<Connector[] | null>(null)
  const [unavailable, setUnavailable] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [syncing, setSyncing] = useState(false)
  const [note, setNote] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const res = await fetch(`${httpBase}/connectors`, { headers: { 'x-session-token': sessionToken } })
      if (!live.current) return
      if (res.status === 503) {
        setUnavailable(t('Connectors are not switched on for this workspace yet.'))
        setConnectors([])
        return
      }
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('Could not load your tools.')); setConnectors([]); return }
      setConnectors(data.connectors || [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
      setConnectors([])
    }
  }, [httpBase, sessionToken])
  useEffect(() => { load() }, [load])

  // The window is opened before the await, not after: a popup opened from a
  // resolved promise is not a user gesture any more, and every browser blocks it.
  const connect = async (id: string) => {
    setBusy(id); setError(null)
    const tab = window.open('', '_blank')
    if (tab) tab.opener = null
    try {
      const res = await fetch(`${httpBase}/connectors/${id}/connect`, {
        method: 'POST',
        headers: { 'x-session-token': sessionToken },
      })
      const data = await res.json().catch(() => ({}))
      if (!live.current) { tab?.close(); return }
      if (!res.ok || !data.redirectUrl) {
        tab?.close()
        setError(data.message || t('Could not start that connection.'))
        return
      }
      if (new URL(data.redirectUrl).protocol !== 'https:') throw new Error(t('A secure connection link could not be opened.'))
      if (tab) tab.location.href = data.redirectUrl
      else window.location.href = data.redirectUrl
      setNote(t('Finish in the tab that opened, then come back and pull.'))
    } catch (err) {
      tab?.close()
      setError(err instanceof Error ? err.message : String(err))
    } finally { setBusy(null) }
  }

  const pull = async () => {
    setSyncing(true); setError(null); setNote(null)
    try {
      const res = await fetch(`${httpBase}/connectors/sync`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-session-token': sessionToken },
        body: JSON.stringify({ orgId }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setError(data.message || t('Nothing could be pulled just now.')); return }
      // One entry per connector, each with what it scanned and what it made.
      const results: Array<{ created?: number; error?: string; skipped?: string }> = data.results || []
      const made = results.reduce((sum, r) => sum + Number(r.created || 0), 0)
      const failed = results.filter((r) => r.error)
      if (failed.length) { setError(failed.map((r) => r.error).join(' · ')); if (!made) return }
      const skipped = results.filter((result) => result.skipped)
      if (skipped.length) { setNote(t('Some connections need configuration before requests can be imported.')); return }
      setNote(made > 0 ? t('{n} new in your feed.', { n: made }) : t('Nothing new needed you.'))
      load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally { setSyncing(false) }
  }

  const active = (connectors || []).filter((c) => c.status === 'active')

  return (
    <div className="screen">
      <div className="screen-head">
        <button className="back" onClick={onClose} aria-label={t('Close')}>‹</button>
        <span className="head-title">{t('Tools')}</span>
      </div>
      <div className="screen-body">
        <p className="lede" style={{ marginTop: 8 }}>
          {t('tools.lede')}
        </p>

        {unavailable && <div className="form-note">{unavailable}</div>}
        {note && <div className="form-note">{note}</div>}
        {error && <div className="form-error">{error}</div>}

        {connectors === null && <div className="empty">{t('Loading…')}</div>}

        {connectors !== null && connectors.length > 0 && (
          <div className="rows">
            {connectors.map((c) => { const Icon = ICON[c.id] || MessageSquare; return (
              <React.Fragment key={c.id}><div className="row static">
                <span className="row-icon"><Icon size={20} strokeWidth={1.7} /></span>
                <span className="row-main">
                  {c.label}
                  <span className="row-sub">{t(BLURB[c.id] || 'Feeds decisions into your feed.')}</span>
                </span>
                {c.status === 'active'
                  ? <span className="pill-tag mint">{t('Connected')}</span>
                  : (
                    <button className="pill-btn" onClick={() => connect(c.id)} disabled={busy === c.id}>
                      {busy === c.id ? '…' : t('Connect')}
                    </button>
                  )}
              </div>{c.id === 'notion' && c.status === 'active' && <NotionConfig httpBase={httpBase} sessionToken={sessionToken} orgId={orgId} onReady={setNotionReady} />}</React.Fragment>
            )})}
          </div>
        )}

        {connectors !== null && connectors.length === 0 && !unavailable && (
          <div className="empty">{t('No connectors are available on this deployment.')}</div>
        )}

        {active.length > 0 && (
          <button className="btn btn-ghost" onClick={pull} disabled={syncing || active.some((c) => c.id === 'notion') && !notionReady}>
            {syncing ? t('Pulling…') : t('Pull now')}
          </button>
        )}

        <p className="form-note">{t('GitHub issue synchronization requires a GitHub-connected workspace.')}</p>
        <div style={{ height: 24 }} />
      </div>
    </div>
  )
}

function NotionConfig({httpBase,sessionToken,orgId,onReady}:{httpBase:string;sessionToken:string;orgId:string;onReady:(ready:boolean)=>void}) {
  const t=useT(), [databases,setDatabases]=useState<Array<{id:string;title:string}>>([]), [selected,setSelected]=useState(''),[saved,setSaved]=useState(''),[busy,setBusy]=useState(false),[loading,setLoading]=useState(true),[error,setError]=useState(''),[message,setMessage]=useState(''), live=useRef(true)
  useEffect(() => { live.current=true; const request=new AbortController(),headers={'x-session-token':sessionToken}; Promise.all([fetch(`${httpBase}/connectors/notion/databases`,{headers,signal:request.signal}).then(readResponse),fetch(`${httpBase}/connectors/notion/config`,{headers,signal:request.signal}).then(readResponse)]).then(([list,config]) => { if(!request.signal.aborted) { setDatabases(list.databases||[]);setSelected(config.databaseId||'');setSaved(config.databaseId||'') } }).catch(() => { if(!request.signal.aborted) setError(t('Notion databases could not be loaded. Reopen Tools to try again.')) }).finally(() => {if(!request.signal.aborted)setLoading(false)});return () => { live.current=false;request.abort();onReady(false) } },[httpBase,sessionToken])
  const ready=!!saved&&saved===selected&&databases.some(d=>d.id===saved)
  useEffect(()=>{onReady(ready)},[ready,onReady])
  const run=async(sync:boolean)=>{ if(busy || sync&&!ready)return;setBusy(true);setError('');setMessage('');try { const result=await readResponse(await fetch(`${httpBase}/connectors/notion/${sync?'sync':'config'}`,{method:sync?'POST':'PUT',headers:{'content-type':'application/json','x-session-token':sessionToken},body:JSON.stringify(sync?{orgId}:{databaseId:selected})}));if(!live.current)return;if(sync)setMessage(t('Notion synced. {n} new requests.',{n:result.created||0}));else{setSaved(selected);setMessage(t('Notion database saved. You can now sync requests.'))} }catch(e){if(live.current)setError(e instanceof Error?e.message:t('Something went wrong.'))}finally{if(live.current)setBusy(false)}}
  return <section className="notion-config" style={{padding:'0 16px 16px'}}><p className="form-note">{t('Choose the database to import requests from before syncing.')}</p>{loading?<p>{t('Loading databases…')}</p>:<><div className="field"><label htmlFor="notion-database">{t('Notion database')}</label><select id="notion-database" value={selected} onChange={e=>setSelected(e.target.value)} disabled={busy||!databases.length}><option value="">{t('Choose a database')}</option>{databases.map(d=><option key={d.id} value={d.id}>{d.title}</option>)}</select></div><div className="compose-actions"><button className="btn btn-ghost" disabled={busy||!selected||selected===saved} onClick={()=>run(false)}>{t('Save database')}</button><button className="btn btn-primary" disabled={busy||!ready} onClick={()=>run(true)}>{t(busy?'Working…':'Sync')}</button></div></>}{!loading&&!databases.length&&!error&&<p className="form-note">{t('No shared databases found. Grant Notion access to a database, then reopen Tools.')}</p>}{error&&<p className="form-error" role="alert">{error}</p>}{message&&<p className="form-note" role="status">{message}</p>}</section>
}
