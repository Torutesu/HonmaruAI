import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppearance } from '../utils/appearance'
import { useT } from '../utils/i18n'
import { formatHistoryDate } from '../utils/appExecutionHistory'
import type { App, AppAction, AppConnection, AppFork, AppEntity, HarnessApi, Row, Table } from '../utils/harness'

import {MAX_PREVIEW_SOURCE} from '../utils/customAppLimits'
import { AppViewportPreview } from './AppViewportPreview'

// Generated apps often refer to a field by the label a person sees, while the
// database API stores values by immutable column ID. Keep IDs intact and add
// non-conflicting label aliases for reads; accept either form for writes.
function appRows(table: Table, rows: Row[]): Row[] {
  const labelCounts = new Map<string, number>()
  for (const column of table.columns) labelCounts.set(column.name, (labelCounts.get(column.name) || 0) + 1)
  return rows.map(row => {
    const values = { ...row.values }
    for (const column of table.columns) {
      if (labelCounts.get(column.name) === 1 && !Object.hasOwn(values, column.name) && Object.hasOwn(values, column.id)) {
        values[column.name] = values[column.id]
      }
    }
    return { ...row, values }
  })
}

function appValues(table: Table, values: Record<string, unknown>): Record<string, unknown> {
  const byName = new Map<string, string>()
  const ambiguous = new Set<string>()
  for (const column of table.columns) {
    if (ambiguous.has(column.name)) continue
    if (!byName.has(column.name)) byName.set(column.name, column.id)
    else { byName.delete(column.name); ambiguous.add(column.name) }
  }
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [byName.get(key) || key, value]))
}

// Two opaque-origin frames isolate generated code and its navigation.
export function CustomAppFrame({ html, table, rows, httpBase, api, reload, appId, previewEntities, loadEntity, decorative = false }: { decorative?: boolean; previewEntities?: Array<AppEntity & {rows:Row[]}>; loadEntity?: (key:string)=>Promise<{table:Table;rows:Row[]}>; appId?: string; html: string; table: Table; rows: Row[]; httpBase: string; api?: HarnessApi; reload?: () => unknown }) {
  const t = useT()
  const frame = useRef<HTMLIFrameElement>(null)
  const initialized = useRef(false)
  const renderId = useRef('')
  const [attempt, setAttempt] = useState(0)
  const [renderState, setRenderState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const { theme } = useAppearance()
  type Change = { targetWindow?: Window | null; targetTable?: Table; action?: AppAction; connection?: AppConnection; remoteMcp?: {serverId:string;toolName:string;title:string}; gatewayId?: string; before?: Row; expectedUpdatedAt?: string; id: string; operation: string; args: { id?: string; values?: Record<string, unknown>; input?: unknown; body?: Record<string,unknown>; entity?: string; name?: string; gatewayId?: string;serverId?:string;toolName?:string;args?:Record<string,unknown> } }
  const [change, setChange] = useState<Change | null>(null)
  const pending = useRef<Change | null>(null)
  const [working, setWorking] = useState(false)
  useLayoutEffect(()=>{initialized.current=false;renderId.current=crypto.randomUUID();pending.current=null;setChange(null);setRenderState('loading')},[html,theme,appId,httpBase,attempt])
  useEffect(() => {
    const timer = setTimeout(() => setRenderState(state => state === 'ready' ? state : 'failed'), 15000)
    return () => clearTimeout(timer)
  }, [html, theme, appId, httpBase, attempt])
  const initialize = (runnerReady = false) => {
    if ((!runnerReady && initialized.current) || !frame.current?.contentWindow) return
    initialized.current = true
    frame.current.contentWindow.postMessage({ type: 'honmaru:init', renderId: renderId.current, html: `<meta name="color-scheme" content="${theme === 'system' ? 'light dark' : theme}"><style>body{background:Canvas;color:CanvasText}</style>${html}`, theme }, '*')
  }
  const reply = (id: string, value?: unknown, error?: string, target: Window | null = frame.current?.contentWindow || null) => target?.postMessage({ type: 'honmaru:result', id, value, error }, '*')
  async function decide(approved: boolean) {
    const current = pending.current
    if (!current || working) return
    setWorking(true)
    try {
      if (!approved) { reply(current.id, undefined, 'The user declined this change.',current.targetWindow); return }
      if (!api) throw new Error('Preview is read-only.')
      const targetTable = current.targetTable || table
      const row = current.before || rows.find(r => r.id === current.args.id)
      let result
      if(current.operation === 'run' && current.action && appId) result = await api.actionChange(appId,{action:'run',name:current.action.name,version:current.action.publishedVersion,gatewayId:current.gatewayId,input:current.args.input,requestId:current.id})
      else if(current.operation === 'connect' && current.connection && appId) result = await api.connectionChange(appId,{action:'request',name:current.connection.name,version:current.connection.version,body:current.args.body,requestId:current.id})
      else if(current.operation === 'remote_mcp' && current.remoteMcp && appId) result = await api.connectionChange(appId,{action:'remote_mcp_request',serverId:current.remoteMcp.serverId,toolName:current.remoteMcp.toolName,args:current.args.args||{},requestId:current.id})
      else
      if (current.operation === 'create') result = await api.addRow(targetTable.id, appValues(targetTable, current.args.values || {}), 'strict')
      else {
        if (!row) throw new Error('No such row in this app.')
        result = current.operation === 'update' ? await api.updateRow(targetTable.id, row.id, appValues(targetTable, current.args.values || {}), current.expectedUpdatedAt, 'strict') : await api.deleteRow(targetTable.id, row.id, current.expectedUpdatedAt)
      }
      reply(current.id, result, undefined,current.targetWindow)
      await reload?.()
    } catch (e) { reply(current.id, undefined, e instanceof Error ? e.message : String(e),current.targetWindow) }
    finally { if(pending.current===current){pending.current=null;setChange(null)} setWorking(false) }
  }

  useLayoutEffect(() => {
    const listener = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      // onLoad can precede the runner's listener (or refer to about:blank).
      // Ready retries delivery; the runner accepts the document only once.
      if (event.data?.type === 'honmaru:ready') { initialize(true); return }
      if (event.data?.type === 'honmaru:rendered' && event.data.renderId === renderId.current) { setRenderState('ready'); return }
      if (event.data?.type !== 'honmaru:request' || typeof event.data.id !== 'string' || event.data.id.length > 80) return
      const { id, operation, args } = event.data
      if (operation === 'read') { reply(id, { table, rows: appRows(table, rows) }); return }
      if (operation === 'entity' && previewEntities) { const entity=previewEntities.find(e=>e.key===args?.entity); entity?reply(id,{table:entity.table,rows:appRows(entity.table,entity.rows)}):reply(id,undefined,'No such preview entity.');return }
      if (operation === 'entity' && loadEntity) {
        try { const key=typeof args?.entity==='string'&&args.entity?args.entity:'primary';const entity=await loadEntity(key);reply(id,{table:entity.table,rows:appRows(entity.table,entity.rows)}) }
        catch(error){reply(id,undefined,error instanceof Error?error.message:'No such entity in this App.')}
        return
      }
      if (!api) { reply(id, undefined, 'Preview is read-only.'); return }
      let size = Infinity
      try { size = JSON.stringify(args).length } catch { /* cyclic input is invalid */ }
      if (!['create', 'update', 'remove', 'entity', 'run', 'connect', 'remote_mcp', 'job'].includes(operation) || !args || typeof args !== 'object' || size > 20000) { reply(id, undefined, 'Invalid request.'); return }
      if (pending.current) { reply(id, undefined, 'Another change is awaiting approval.'); return }
      // Reserve the approval slot before asynchronous capability discovery.
      const request: Change = { id, operation, args, targetWindow:frame.current?.contentWindow }
      pending.current = request
      try {
        if(['run','connect','remote_mcp','job','entity'].includes(operation) || args.entity && args.entity !== 'primary') {
          if(previewEntities && args.entity && !['run','connect','remote_mcp','job'].includes(operation)) {
            const entity=previewEntities.find(e=>e.key===args.entity);if(!entity)throw new Error('No such preview entity.');request.targetTable=entity.table;request.before=entity.rows.find(r=>r.id===args.id)
          } else if(loadEntity&&args.entity&&args.entity!=='primary'&&!['run','connect','job'].includes(operation)) {
            const entity=await loadEntity(String(args.entity));request.targetTable=entity.table;request.before=entity.rows.find(r=>r.id===args.id)
          } else {
          if(!appId) throw new Error('This capability is unavailable in preview.')
          if(operation==='job') { reply(id,await api.actionJob(appId,String(args.id||'')));pending.current=null;return }
          if(operation==='run') {
            const action=(await api.appActions(appId)).actions.find(a=>a.name===args.name&&a.published)
            if(!action)throw new Error('No published action.')
            const gateway=(await api.gateways()).gateways.find(g=>g.id===args.gatewayId&&!g.revokedAt)
            if(!gateway)throw new Error('Choose an available execution node.')
            request.action=action;request.gatewayId=gateway.id
          } else if(operation==='connect') {
            const connection=(await api.appConnections(appId)).connections.find(c=>c.name===args.name&&c.enabled)
            if(!connection)throw new Error('No enabled connection for your account.')
            request.connection=connection
          } else if(operation==='remote_mcp') {
            const {remoteMcp}=await api.appConnections(appId)
            const remote=remoteMcp?.tools.find(tool=>tool.serverId===args.serverId&&tool.toolName===args.toolName&&tool.granted)
            if(!remote)throw new Error('No read-only Remote MCP tool shared with this App.')
            request.remoteMcp={serverId:remote.serverId,toolName:remote.toolName,title:remote.title}
          } else {
            const entity=(await api.appDatabase(appId)).entities.find(e=>e.key===(args.entity||'primary'))
            if(!entity)throw new Error('No such entity in this app.')
            const data=await api.entityRows(entity.table.id)
            if(operation==='entity'){reply(id,{...data,rows:appRows(entity.table,data.rows)});pending.current=null;return}
            request.targetTable=entity.table
            request.before=data.rows.find(r=>r.id===args.id)
          }
        }
        }
        if(['create','update','remove'].includes(operation)) {
          const row=request.targetTable?request.before:rows.find(r=>r.id===args.id)
          if(operation!=='create'&&!row)throw new Error('No such row in this app.')
          request.before=row;request.expectedUpdatedAt=row?.updatedAt
        }
        if(pending.current===request) setChange(request)
      } catch(e){pending.current=null;reply(id,undefined,e instanceof Error?e.message:String(e))}

    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [table, rows, html, theme, api, appId, previewEntities, loadEntity, httpBase, attempt])
  const labeled = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([id, value]) => [(change?.targetTable || table).columns.find(c => c.id === id)?.name || id, value]))
  if (html.length > MAX_PREVIEW_SOURCE) return <p role="alert">{t('The code exceeds the 119800 character preview limit. Shorten it before saving.')}</p>
  return <>{change && <div className="hx-custom-approval" role="alertdialog" aria-label={t('Confirm app data change')}><h3>{change.action ? t('Confirm server action') : change.connection ? t('Confirm external API read') : change.remoteMcp ? t('Confirm Remote MCP read') : t('Confirm data change')}</h3><p>{change.remoteMcp?.title || change.targetTable?.name || table.name} · {change.operation === 'create' ? t('Add row') : change.operation === 'update' ? t('Update row') : change.operation === 'run' ? t('Server action') : change.operation === 'connect' ? t('External API') : change.operation === 'remote_mcp' ? t('Read-only tool') : t('Delete row')}</p><pre>{JSON.stringify(change.action ? {[t('Action')]:change.action.name,[t('Published version')]:change.action.publishedVersion,[t('Code')]:change.action.published,[t('Input')]:change.args.input,[t('Execution node')]:change.gatewayId} : change.connection ? {[t('API connection')]:change.connection.name,URL:change.connection.endpoint,[t('Method')]:change.connection.method||'GET',[t('Request body')]:change.args.body||null} : change.remoteMcp ? {[t('Tool')]:change.remoteMcp.title,[t('Arguments')]:change.args.args||{}} : { ...(change.before ? { [t('Record')]: change.before.id, [t('Previous values')]: labeled(change.before.values) } : {}), ...(change.operation !== 'remove' ? { [t('Changes')]: labeled(change.args.values || {}) } : {}) }, null, 2)}</pre>{change.remoteMcp&&<p>{t('This read-only tool is shared with this app and will run using the connection owner’s authorization. The destination and credentials are not exposed to the app.')}</p>}<button disabled={working} onClick={() => decide(false)}>{t('Cancel')}</button><button disabled={working} onClick={() => decide(true)}>{t('Allow this change')}</button></div>}{renderState !== 'ready' && <div className="hx-custom-status" role="status">{renderState === 'loading' ? t('Loading app…') : <><span>{t('The app could not be displayed.')}</span><button type="button" onClick={() => setAttempt(value => value + 1)}>{t('Try again')}</button></>}</div>}<iframe tabIndex={decorative ? -1 : undefined} ref={frame} onLoad={() => initialize()} title={t('Custom app')} sandbox="allow-scripts" referrerPolicy="no-referrer" key={`${html}:${theme}:${appId}:${httpBase}:${attempt}`} src={`${httpBase}/custom-app-runner?v=4`} className="hx-custom-frame" /></>
}

type CustomAppHistoryEntry = {
  version: number
  note: string | null
  createdAt: string
  release?: { publishedAt: string; publishedBy: string; publishedByName?: string | null; source: 'inline' | 'github-commit'; commitSha?: string; current: boolean; status: 'current' | 'replaced' | 'stopped'; version: number; isReleaseVersion: boolean } | null
  releaseEvent?: { type: 'unpublished'; at: string; by: string }
  approvals?: Array<{ kind: 'inline' | 'github-commit'; status: 'pending' | 'approved' | 'rejected' | 'revoked' | 'published'; requestedBy: string; requestedByName: string; reviewerId: string | null; reviewerName: string | null; requestedAt: string; reviewedAt: string | null }>
}

export function CustomAppReleaseHistory({ history, busy, restore, next, hasMore, loading }: { history: CustomAppHistoryEntry[]; busy: boolean; restore: (version: number) => void; next?: () => void; hasMore?: boolean; loading?: boolean }) {
  const t = useT()
  const approvalStatus: Record<NonNullable<CustomAppHistoryEntry['approvals']>[number]['status'], string> = {
    pending: t('Awaiting approval'), approved: t('Approved · awaiting publication'), rejected: t('Rejected'), revoked: t('Revoked'), published: t('Published'),
  }
  const releaseStatus: Record<NonNullable<CustomAppHistoryEntry['release']>['status'], string> = {
    current: t('Currently published'), replaced: t('Replaced by a later version'), stopped: t('Publication stopped'),
  }
  return <>{history.filter(v => v.note?.startsWith('Custom app:') || v.note?.startsWith('GitHub commit:')).map(v => <article key={v.version} className="hx-custom-history-entry">
    <p><strong>v{v.version}</strong> · {v.note} · {formatHistoryDate(v.createdAt,t)}</p>
    {v.release ? <p role="status">{v.release.isReleaseVersion ? releaseStatus[v.release.status] : t('Published version v{version} remains active', { version: v.release.version })} · {formatHistoryDate(v.release.publishedAt,t)} · {v.release.source === 'github-commit' ? t('GitHub {sha}', { sha: v.release.commitSha?.slice(0, 12) || '' }) : t('Custom code')} · {t('Published by {name}', { name: v.release.publishedByName || v.release.publishedBy })}</p>
      : v.releaseEvent?.type === 'unpublished' ? <p role="status">{t('Publication stopped')} · {formatHistoryDate(v.releaseEvent.at,t)}</p>
        : <p>{t('Unpublished draft')}</p>}
    {v.approvals?.map((approval, index) => <p key={`${approval.kind}-${approval.requestedAt}-${index}`} role="status">{approval.kind === 'github-commit' ? t('GitHub commit review') : t('Publication review')} · {approvalStatus[approval.status]} · {t('Requested by {name}', { name: approval.requestedByName })} · {approval.reviewedAt ? t('Reviewed by {name} · {time}', { name: approval.reviewerName || approval.reviewerId || '', time: formatHistoryDate(approval.reviewedAt,t) }) : t('Requested {time}', { time: formatHistoryDate(approval.requestedAt,t) })}</p>)}
    {v.release?.isReleaseVersion && !v.release.current ? <><button className="pill-btn quiet" disabled={busy} onClick={() => restore(v.version)}>{t('Restore this published version as a draft')}</button><p>{t('After restoring, publish it again under the current approval rules. The history will record it as a new version.')}</p></> : !v.release && !v.releaseEvent ? <button className="pill-btn quiet" disabled={busy} onClick={() => restore(v.version)}>{t('Restore draft')}</button> : null}
  </article>)}{hasMore&&<button type="button" className="pill-btn quiet" disabled={busy||loading} onClick={next}>{loading?t('Loading…'):t('Load older versions')}</button>}</>
}

export function CustomAppEditor({ app, table, rows, api, reload, httpBase }: { app: App; table: Table; rows: Row[]; api: HarnessApi; reload: () => unknown; httpBase: string }) {
  const t=useT(),scope=useMemo(()=>({}),[app.id,api]),activeScope=useRef<object|null>(scope);activeScope.current=scope
  const [html, setHtml] = useState(app.definition.custom?.draft || '')
  const htmlRef=useRef(html),editGeneration=useRef(0),remote=useRef({scope,draft:app.definition.custom?.draft||'',generation:0}),pending=useRef<{scope:object}|null>(null)
  const [shownScope,setShownScope]=useState(scope),[generated,setGenerated]=useState<{html:string;prompt:string;startingHtml:string;contextGeneration:number;version:number}|null>(null),[remoteChanged,setRemoteChanged]=useState(false)
  const promptGeneration=useRef(0),context=JSON.stringify([app.version,app.definition.custom?.draft||'',table.id,table.columns]),contextRef=useRef(context),contextGeneration=useRef(0)
  if(contextRef.current!==context){contextRef.current=context;contextGeneration.current++}
  const [prompt, setPrompt] = useState('')
  const [preview, setPreview] = useState(Boolean(app.definition.custom?.draft))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<CustomAppHistoryEntry[]>([])
  const [historyCursor,setHistoryCursor]=useState<string|null>(null),[historyLoaded,setHistoryLoaded]=useState(false),[historyLoading,setHistoryLoading]=useState(false)
  const historyOpen=useRef(false)
  const [commitState,setCommitState]=useState<Awaited<ReturnType<typeof api.customCommitState>>|null>(null)
  const [publishGate,setPublishGate]=useState<Awaited<ReturnType<typeof api.customPublishState>>|null>(null)
  const [gitOwner,setGitOwner]=useState(''),[gitRepo,setGitRepo]=useState(''),[gitBranch,setGitBranch]=useState('main'),[gitSha,setGitSha]=useState('')
  const [hosting,setHosting]=useState<Awaited<ReturnType<typeof api.appHosting>>|null>(null)
  const [domainHostname,setDomainHostname]=useState(''),[publicDataConfirmed,setPublicDataConfirmed]=useState(false),[hostingError,setHostingError]=useState('')
  useLayoutEffect(()=>{
    activeScope.current=scope
    const draft=app.definition.custom?.draft||''
    htmlRef.current=draft;editGeneration.current++;remote.current={scope,draft,generation:editGeneration.current};promptGeneration.current++;pending.current=null
    setHtml(draft);setPrompt('');setPreview(Boolean(draft));setGenerated(null);setRemoteChanged(false);setBusy(false);setError('');setHistory([]);setHistoryCursor(null);setHistoryLoaded(false);setHistoryLoading(false);historyOpen.current=false;setShownScope(scope)
    return()=>{if(activeScope.current===scope)activeScope.current=null}
  },[scope])
  useEffect(()=>{
    let active=true
    if(typeof api.customCommitState!=='function')return()=>{active=false}
    api.customCommitState(app.id).then(state=>{if(active)setCommitState(state)}).catch(e=>{if(active)setError(e instanceof Error?e.message:String(e))})
    return()=>{active=false}
  },[api,app.id,app.version,app.definition.custom?.draft])
  useEffect(()=>{
    let active=true
    if(typeof api.customPublishState!=='function')return()=>{active=false}
    api.customPublishState(app.id).then(state=>{if(active)setPublishGate(state)}).catch(e=>{if(active)setError(e instanceof Error?e.message:String(e))})
    return()=>{active=false}
  },[api,app.id,app.version,app.definition.custom?.draft])
  useEffect(()=>{
    let active=true
    if(typeof api.appHosting!=='function')return()=>{active=false}
    api.appHosting(app.id).then(state=>{if(active){setHosting(state);setDomainHostname(state.domain?.hostname||'')}}).catch(e=>{if(active)setHostingError(e instanceof Error?e.message:String(e))})
    return()=>{active=false}
  },[api,app.id,app.version])
  useEffect(()=>{
    if(remote.current.scope!==scope)return
    const draft=app.definition.custom?.draft||'',previous=remote.current.draft
    if(draft===previous)return
    const pristine=htmlRef.current===previous&&editGeneration.current===remote.current.generation
    editGeneration.current++;remote.current={scope,draft,generation:editGeneration.current}
    if(pristine){htmlRef.current=draft;setHtml(draft);setRemoteChanged(false)}
    else setRemoteChanged(htmlRef.current!==draft)
  },[scope,app.definition.custom?.draft])
  async function run(action: () => Promise<unknown>) {
    if(pending.current?.scope===scope)return
    const operation={scope};pending.current=operation
    setBusy(true); setError('')
    try { await action() } catch (e) { if(activeScope.current===scope)setError(e instanceof Error ? e.message : String(e)) } finally { if(pending.current===operation){pending.current=null;if(activeScope.current===scope)setBusy(false)} }
  }
  async function loadHistory(cursor?: string) {
    if(historyLoading)return
    setHistoryLoading(true)
    try {
      const page=await api.versions(app.id,cursor)
      if(activeScope.current!==scope)return
      setHistory(previous=>cursor?[...previous,...page.versions]:page.versions)
      setHistoryCursor(page.nextCursor||null);setHistoryLoaded(true)
    } catch(e) { if(activeScope.current===scope)setError(String(e)) }
    finally { if(activeScope.current===scope)setHistoryLoading(false) }
  }
  useEffect(()=>{
    setHistory([]);setHistoryCursor(null);setHistoryLoaded(false)
    if(historyOpen.current)void loadHistory()
  },[app.id,app.version])
  const changed = html !== (app.definition.custom?.draft || '')
  const currentRemote=app.definition.custom?.draft||''
  const remoteConflict=remoteChanged||(remote.current.scope===scope&&remote.current.draft!==currentRemote&&(htmlRef.current!==remote.current.draft||editGeneration.current!==remote.current.generation)&&htmlRef.current!==currentRemote)
  if(shownScope!==scope)return <section className="hx-custom-editor" role="status">{t('Loading custom app…')}</section>
  return <section className="hx-custom-editor">
    <h2>{t('Custom app')}</h2><p>{t('Build a custom interface with HTML, CSS, and JavaScript. Create a preview database to try writes separately from production; without one, the preview is read-only. Every data change after publication requires confirmation. Review the saved draft before publishing.')}</p>
    <form onSubmit={e => { e.preventDefault();if(generated!==null||!prompt.trim())return;const started=editGeneration.current,startedPrompt=promptGeneration.current,startedContext=contextGeneration.current,startedConflict=remoteConflict,request=prompt,version=app.version,startingHtml=htmlRef.current;void run(async () => { const result = await api.generateCustom(app.id, request);if(activeScope.current!==scope)return;if(typeof result?.html!=='string'||!result.html.trim()||result.html.length>120000)throw new Error(t('Could not verify the generated result. Your current code has been kept.'));if(startedConflict||editGeneration.current!==started||promptGeneration.current!==startedPrompt||contextGeneration.current!==startedContext)setGenerated({html:result.html,prompt:request,startingHtml,contextGeneration:startedContext,version});else{htmlRef.current=result.html;editGeneration.current++;setHtml(result.html);setPreview(true)} }) }}>
      <textarea aria-label={t('Describe the custom app you want')} placeholder={t('e.g. A dashboard that highlights tasks nearing their deadline, filters by assignee, and shows completion rates.')} value={prompt} maxLength={4000} onChange={e => {promptGeneration.current++;setPrompt(e.target.value)}} />
      <button className="pill-btn" disabled={busy || generated!==null || !prompt.trim()}>{busy ? t('Generating…') : t('Generate code from a description')}</button>
    </form>
    {error && <p role="alert" className="form-error">{error}</p>}
    {remoteConflict&&<section aria-label={t('Saved code changed')}><p role="status">{t('The saved code has changed. Your edits are preserved. Review the current code before saving.')}</p><label>{t('Currently saved code')}<textarea className="hx-code-editor" aria-label={t('Currently saved code')} value={currentRemote} readOnly rows={6}/></label><div className="hx-actions"><button type="button" className="pill-btn quiet" onClick={()=>{if(!window.confirm(t('Discard your edits and use the currently saved code?')))return;htmlRef.current=currentRemote;editGeneration.current++;remote.current={scope,draft:currentRemote,generation:editGeneration.current};setHtml(currentRemote);setPreview(false);setRemoteChanged(false)}}>{t('Use saved code')}</button><button type="button" className="pill-btn quiet" onClick={()=>{if(!window.confirm(t('Keep your edits? The next save will overwrite the currently saved code.')))return;setRemoteChanged(false)}}>{t('Continue with my edits')}</button></div></section>}
    <details className="hx-custom-source"><summary>{t('Edit code')}</summary><label>HTML / CSS / JavaScript<textarea className="hx-code-editor" aria-label={t('Custom app source')} value={html} maxLength={119800} spellCheck={false} onChange={e => {htmlRef.current=e.target.value;editGeneration.current++;setHtml(e.target.value); setPreview(false) }} /></label></details>
    {generated!==null&&<section aria-label={t('Review generated result')}><p role="status">{t('Your input or the app changed while code was generating, so your current code was not changed. Review the generated result and choose whether to use it.')}</p>{generated.contextGeneration!==contextGeneration.current&&<p role="status">{t('The app changed since version {version} was used to generate this result. Check that it still fits the current app.', { version: generated.version })}</p>}<label>{t('Code being edited when generation started')}<textarea className="hx-code-editor" aria-label={t('Code being edited when generation started')} value={generated.startingHtml} readOnly rows={6}/></label><label>{t('Submitted request')}<textarea aria-label={t('Generation request')} value={generated.prompt} readOnly rows={2}/></label><label>{t('Generated result')}<textarea className="hx-code-editor" aria-label={t('Generated code')} value={generated.html} readOnly rows={6}/></label><div className="hx-actions"><button type="button" className="pill-btn" onClick={()=>{const warning=generated.contextGeneration!==contextGeneration.current?t('The app changed since version {version} was used to generate this result. ', { version: generated.version }):'';if(!window.confirm(`${warning}${t('Replace the code you are editing with this generated result? Your current code will not be saved automatically.')}`))return;htmlRef.current=generated.html;editGeneration.current++;setHtml(generated.html);setGenerated(null);setPreview(true)}}>{t('Use generated result')}</button><button type="button" className="pill-btn quiet" onClick={()=>setGenerated(null)}>{t('Discard generated result and keep current code')}</button></div></section>}
    <section className="hx-commit-release" aria-label={t('GitHub draft integration')}>
      <h3>{t('GitHub app draft')}</h3>
      <p>{t('Sync HTML and static assets to this app’s dedicated branch using your GitHub account permissions. After connecting, new commits are checked about once a minute and imported into this app’s saved draft. Published apps are not changed automatically. Review changes in the isolated preview database; the existing approval process applies to publishing.')}</p>
      {commitState?.gitDraft ? <>
        <p role="status">{t('Connected to')} <code>{commitState.gitDraft.owner}/{commitState.gitDraft.repo}</code> · {t('Branch')} <code>{commitState.gitDraft.branch}</code> · {t('File')} <code>{commitState.gitDraft.path}</code>{commitState.gitDraft.headSha&&<> · HEAD <code>{commitState.gitDraft.headSha.slice(0,12)}</code></>}</p>
        {commitState.gitDraftAutoSync?.lastError?<p role="alert">{t('GitHub automatic sync is paused. Check the GitHub connection and branch.')} {commitState.gitDraftAutoSync.lastError}</p>:<p role="status">{t('Automatic sync')} {commitState.gitDraftAutoSync?.lastCheckAt?`${t('Last checked')} ${formatHistoryDate(commitState.gitDraftAutoSync.lastCheckAt,t)}`:t('Waiting for the next check')}</p>}
        <div className="hx-actions">
          <button type="button" className="pill-btn" disabled={busy||!html.trim()||html.length>MAX_PREVIEW_SOURCE||remoteConflict} onClick={()=>void run(async()=>{await api.customCommit(app.id,{action:'sync_git_draft',version:app.version,html});await reload();setCommitState(await api.customCommitState(app.id));setPublishGate(await api.customPublishState(app.id))})}>{t('Sync current code to GitHub draft')}</button>
          <button type="button" className="pill-btn quiet" disabled={busy||remoteConflict} onClick={()=>{if(changed&&!window.confirm(t('Replace saved code with the latest GitHub draft? Your edits are kept, and the published app will not change.')))return;void run(async()=>{await api.customCommit(app.id,{action:'refresh_git_draft',version:app.version});await reload();setCommitState(await api.customCommitState(app.id));setPublishGate(await api.customPublishState(app.id))})}}>{t('Import latest GitHub draft')}</button>
          <button type="button" className="pill-btn quiet" disabled={busy} onClick={()=>{if(!window.confirm(t('Disconnect this app from the GitHub repository? The draft branch on GitHub will remain.')))return;void run(async()=>{await api.customCommit(app.id,{action:'unbind_git_repo',version:app.version});setCommitState(await api.customCommitState(app.id))})}}>{t('Disconnect repository')}</button>
        </div>
      </> : <div className="hx-form-grid">
        <label>{t('GitHub owner')}<input aria-label={t('Draft GitHub owner')} value={gitOwner} onChange={e=>setGitOwner(e.target.value)} /></label>
        <label>{t('Repository')}<input aria-label={t('Draft GitHub repository')} value={gitRepo} onChange={e=>setGitRepo(e.target.value)} /></label>
        <button type="button" className="pill-btn" disabled={busy||!gitOwner.trim()||!gitRepo.trim()} onClick={()=>void run(async()=>{await api.customCommit(app.id,{action:'bind_git_repo',version:app.version,owner:gitOwner.trim(),repo:gitRepo.trim()});setCommitState(await api.customCommitState(app.id))})}>{t('Connect repository to this app')}</button>
      </div>}
    </section>
    <section className="hx-commit-release" aria-label={t('Publish from GitHub commit')}>
      <h3>{t('Publish from a GitHub commit')}</h3>
      <p>{t('Imports only the HTML and static assets from a pinned commit using the connected GitHub account. A different Owner/Admin must approve the visibility and saved bundle. No build runs and nothing is written to GitHub.')}</p>
      <div className="hx-form-grid">
        <label>{t('Owner')}<input aria-label={t('GitHub owner')} value={gitOwner} onChange={e=>setGitOwner(e.target.value)} /></label>
        <label>{t('Repository')}<input aria-label={t('GitHub repository')} value={gitRepo} onChange={e=>setGitRepo(e.target.value)} /></label>
        <label>{t('Branch')}<input aria-label={t('GitHub branch')} value={gitBranch} onChange={e=>setGitBranch(e.target.value)} /></label>
        <label>{t('Full commit SHA')}<input aria-label={t('GitHub commit SHA')} value={gitSha} onChange={e=>setGitSha(e.target.value)} /></label>
      </div>
      <button type="button" className="pill-btn quiet" disabled={busy||!gitOwner.trim()||!gitRepo.trim()||!gitBranch.trim()||!gitSha.trim()} onClick={()=>void run(async()=>{
        await api.customCommit(app.id,{action:'import_commit',owner:gitOwner.trim(),repo:gitRepo.trim(),branch:gitBranch.trim(),commitSha:gitSha.trim()})
        await reload()
        setCommitState(await api.customCommitState(app.id))
      })}>{t('Import commit HTML and static assets')}</button>
      {commitState?.commit&&<div className="hx-commit-review" aria-label="GitHub commit approval">
        <p>{t('Pinned commit')}: <code>{commitState.commit.owner}/{commitState.commit.repo}@{commitState.commit.sha}</code> · {commitState.commit.assets.length} {t('assets')} · SHA-256 {commitState.commit.sourceHash.slice(0,12)}…</p>
        <p>{t('Target version')} v{commitState.commit.appVersion} · {t('Visibility')} {commitState.scope?.visibility||'unknown'}{commitState.scope?.domainScope ? ' · domain '+commitState.scope.domainScope : ''}</p>
        {(!commitState.approval||['rejected','revoked'].includes(commitState.approval.status))&&<button type="button" className="pill-btn" disabled={busy||changed||remoteConflict||!publishGate?.candidate?.current||publishGate.candidate.sourceHash!==commitState.commit.htmlHash} onClick={()=>void run(async()=>{
          await api.customCommit(app.id,{action:'request_commit_approval',version:app.version,candidateId:publishGate?.candidate?.id})
          setCommitState(await api.customCommitState(app.id))
        })}>{t('Request approval for this commit')}</button>}
        {commitState.approval&&<p role="status">{t('Approval status')}: {commitState.approval.status} · v{commitState.approval.appVersion} · {commitState.approval.visibility}</p>}
        {commitState.approval?.status==='pending'&&<div className="hx-actions">
          <button type="button" className="pill-btn" disabled={busy||!publishGate?.candidate?.current||commitState.approval.previewCandidateId!==publishGate.candidate.id} onClick={()=>void run(async()=>{
            await api.customCommit(app.id,{action:'review_commit_approval',decision:'approve',approvalId:commitState.approval?.id,version:app.version,commitSha:commitState.approval?.commitSha,sourceHash:commitState.approval?.sourceHash,candidateId:publishGate?.candidate?.id})
            setCommitState(await api.customCommitState(app.id))
          })}>{t('Approve as Owner/Admin')}</button>
          <button type="button" className="pill-btn quiet" disabled={busy||!publishGate?.candidate?.current||commitState.approval.previewCandidateId!==publishGate.candidate.id} onClick={()=>void run(async()=>{
            await api.customCommit(app.id,{action:'review_commit_approval',decision:'reject',approvalId:commitState.approval?.id,version:app.version,commitSha:commitState.approval?.commitSha,sourceHash:commitState.approval?.sourceHash,candidateId:publishGate?.candidate?.id})
            setCommitState(await api.customCommitState(app.id))
          })}>{t('Reject')}</button>
        </div>}
        {commitState.approval?.status==='approved'&&<p>{t('A creator other than the approver, or an Owner/Admin, can publish. This approval cannot be used if the branch moves.')}</p>}
      </div>}
    </section>
    <section className="hx-commit-release" aria-label={t('Custom domain publishing')}>
      <h3>{t('Publish on a custom domain')}</h3>
      <p>{t('Connect a published custom app to your own domain. Anyone who knows the domain can view the custom interface and all records. This is a separate public access grant from the app’s workspace sharing settings.')}</p>
      {hostingError&&<p role="alert" className="form-error">{hostingError}</p>}
      {hosting?.domain
        ? <div><p role="status">{hosting.domain.hostname} · {hosting.domain.status}</p><button type="button" className="pill-btn quiet" disabled={busy} onClick={()=>void run(async()=>{await api.changeAppHosting(app.id,{action:'remove'});setHosting(await api.appHosting(app.id));setPublicDataConfirmed(false)})}>{t('Remove custom domain')}</button></div>
        : <div className="hx-form-grid">
          <label>{t('Full hostname')}<input aria-label={t('Custom domain hostname')} value={domainHostname} onChange={e=>setDomainHostname(e.target.value)} placeholder="app.example.com" /></label>
          <label className="hx-domain-confirm"><input type="checkbox" aria-label={t('Confirm public access to all records')} checked={publicDataConfirmed} onChange={e=>setPublicDataConfirmed(e.target.checked)} />{t('Anyone can view the custom interface and all records on this domain. I confirm that it may be made public.')}</label>
          <button type="button" className="pill-btn" disabled={busy||!hosting?.configured||!domainHostname.trim()||!publicDataConfirmed||!app.definition.custom?.published} onClick={()=>void run(async()=>{await api.changeAppHosting(app.id,{action:'attach',hostname:domainHostname.trim(),publicDataConfirmed:true});setHosting(await api.appHosting(app.id));setPublicDataConfirmed(false)})}>{t('Add custom domain')}</button>
          {hosting&&!hosting.configured&&<p role="status">{t('Custom domain management is not configured in this environment.')}</p>}
        </div>}
    </section>
    <section className="hx-release-approval" aria-label={t('Publishing approval policy')}>
      <h3>{t('Publishing governance')}</h3>
      <p>{publishGate?.policy.enabled?t('Approval by an Owner or Admin other than the creator is required. Approval is tied to the current draft and version.'):t('By default, the creator or an administrator can publish directly.')}</p>
      <button type="button" className="pill-btn quiet" disabled={busy||!publishGate} onClick={()=>void run(async()=>{await api.customPublish(app.id,{action:'policy',enabled:!publishGate?.policy.enabled});setPublishGate(await api.customPublishState(app.id))})}>{publishGate?.policy.enabled?t('Disable required independent approval'):t('Require independent Owner/Admin approval before publishing')}</button>
      {publishGate?.policy.enabled&&<div>
        {!publishGate.approval||['rejected','revoked'].includes(publishGate.approval.status)?<button type="button" className="pill-btn" disabled={busy||changed||remoteConflict||!html||html.length>MAX_PREVIEW_SOURCE||!publishGate.candidate?.current} onClick={()=>void run(async()=>{await api.customPublish(app.id,{action:'request_approval',version:app.version,candidateId:publishGate.candidate?.id});setPublishGate(await api.customPublishState(app.id))})}>{t('Request approval for this preview')}</button>:<><p role="status">{t('Approval status')}: {publishGate.approval.status} · v{publishGate.approval.draftVersion} · {t('Visibility')}: {publishGate.approval.scope} · SHA-256: {publishGate.approval.sourceHash.slice(0,12)}…</p><p>{t('A creator other than the approver, or an Owner/Admin, can publish. The server verifies that the approver and publisher are different people.')}</p></>}
        {publishGate.approval?.status==='pending'&&<div className="hx-actions"><button type="button" className="pill-btn" disabled={busy||!publishGate.candidate?.current} onClick={()=>void run(async()=>{await api.customPublish(app.id,{action:'review',decision:'approve',approvalId:publishGate.approval?.id,version:app.version,sourceHash:publishGate.sourceHash,candidateId:publishGate.candidate?.id});setPublishGate(await api.customPublishState(app.id))})}>{t('Approve as Owner/Admin')}</button><button type="button" className="pill-btn quiet" disabled={busy||!publishGate.candidate?.current} onClick={()=>void run(async()=>{await api.customPublish(app.id,{action:'review',decision:'reject',approvalId:publishGate.approval?.id,version:app.version,sourceHash:publishGate.sourceHash,candidateId:publishGate.candidate?.id});setPublishGate(await api.customPublishState(app.id))})}>{t('Reject')}</button></div>}
      </div>}
    </section>
    <div className="hx-actions">
      <button className="pill-btn quiet" disabled={!html || busy} onClick={() => setPreview(v => !v)}>{preview ? t('Close preview') : t('Preview')}</button>
      <button className="pill-btn" disabled={busy || remoteConflict || !html || !changed} onClick={() => {if(remoteConflict)return;void run(async () => { await api.saveCustom(app.id, 'draft', app.version, html); if(activeScope.current===scope)await reload() })}}>{t('Save draft')}</button>
      <button className="pill-btn" disabled={busy || !publishGate || !publishGate.candidate?.current || remoteConflict || changed || !html || html.length > MAX_PREVIEW_SOURCE || html === app.definition.custom?.published || Boolean(commitState?.commit && commitState.approval?.status!=='approved') || Boolean(publishGate?.policy.enabled && publishGate.approval?.status!=='approved')} onClick={() => {if(remoteConflict||html.length > MAX_PREVIEW_SOURCE)return;void run(async () => { if(commitState?.commit){await api.customCommit(app.id,{action:'publish_commit',version:app.version,approvalId:commitState.approval?.id,candidateId:publishGate?.candidate?.id})}else{await api.saveCustom(app.id, 'publish', app.version,undefined,undefined,publishGate?.candidate?.id)} if(activeScope.current===scope)await reload();setCommitState(await api.customCommitState(app.id));setPublishGate(await api.customPublishState(app.id)) })}}>{commitState?.commit?t('Publish approved GitHub commit'):publishGate?.policy.enabled?t('Publish approved preview'):t('Publish previewed draft')}</button>
      {app.definition.custom?.published && <button className="pill-btn quiet" disabled={busy} onClick={() => void run(async () => { await api.saveCustom(app.id, 'unpublish', app.version); if(activeScope.current===scope)await reload() })}>{t('Unpublish')}</button>}
    </div>
    {html.length > MAX_PREVIEW_SOURCE && <p role="alert" className="form-error">{t('Shorten the code to 119,800 characters or fewer to preview and publish. The draft is preserved.')}</p>}
    <details onToggle={e => { historyOpen.current=e.currentTarget.open;if(e.currentTarget.open&&!historyLoaded)void loadHistory() }}><summary>{t('Publication and code history')}</summary><CustomAppReleaseHistory history={history} busy={busy} loading={historyLoading} hasMore={Boolean(historyCursor)} next={()=>{if(historyCursor)void loadHistory(historyCursor)}} restore={version => void run(async () => { const entry=history.find(item=>item.version===version); await api.saveCustom(app.id, entry?.release ? 'restore_release' : 'restore', app.version, undefined, version); if(activeScope.current===scope)await reload() })} /></details>
    <small>{changed ? t('Unsaved changes') : `${t('Version')} ${app.version}`} · {t('No direct external requests; connections require confirmation · Inherits app viewing permissions · Publishing actions are recorded in the audit log')}</small>
    {preview && <ForkPreview appId={app.id} version={app.version} api={api} httpBase={httpBase} html={html} table={table} rows={rows} canReview={!changed&&!remoteConflict&&html.length<=MAX_PREVIEW_SOURCE} candidate={publishGate?.candidate||null} onCandidate={async(forkId,revision)=>{await api.customPublish(app.id,{action:'preview_candidate',version:app.version,forkId,revision});setPublishGate(await api.customPublishState(app.id))}} onForkChange={async()=>setPublishGate(await api.customPublishState(app.id))} />}
  </section>
}

function ForkPreview({appId,version,api,httpBase,html,table,rows,canReview,candidate,onCandidate,onForkChange}:{appId:string;version:number;api:HarnessApi;httpBase:string;html:string;table:Table;rows:Row[];canReview:boolean;candidate:{id:string;current:boolean;forkRevision:number;staleReason?:string}|null;onCandidate:(forkId:string,revision:number)=>Promise<void>;onForkChange:()=>Promise<void>}) {
  const t=useT()
  const [fork,setFork]=useState<AppFork|null>(null)
  const [loadedAppId,setLoadedAppId]=useState('')
  const [error,setError]=useState('')
  const [reviewing,setReviewing]=useState(false)
  const [confirmRefresh,setConfirmRefresh]=useState(false)
  const current=useRef<AppFork|null>(null)
  const load=async()=>{try{setError('');const d=await api.customPreviewDatabase(appId,version);current.current=d.fork;setFork(d.fork);setLoadedAppId(appId);await onForkChange()}catch(e){setError(String(e))}}
  useEffect(()=>{current.current=null;setFork(null);setLoadedAppId('');void load()},[appId,version,api])
  const mutate=async(tableId:string,operation:string,values?:Record<string,unknown>,rowId?:string,expectedUpdatedAt?:string)=>{
    const f=current.current;if(!f)throw new Error(t('No preview database.'))
    const entity=f.entities.find(e=>e.table.id===tableId);if(!entity)throw new Error(t('No such preview entity.'))
    const r=await api.customPreviewWrite(appId,version,{forkId:f.id,revision:f.revision,entity:entity.key,operation,values,rowId,expectedUpdatedAt})
    await load();return operation==='remove'?r.result:{row:r.result}
  }
  const staleSchema=candidate?.staleReason==='database_schema_changed'
  const adapter=fork&&!fork.mergedAt&&!staleSchema?{addRow:(t:string,v:Record<string,unknown>)=>mutate(t,'create',v),updateRow:(t:string,id:string,v:Record<string,unknown>,expected?:string)=>mutate(t,'update',v,id,expected),deleteRow:(t:string,id:string,expected?:string)=>mutate(t,'remove',undefined,id,expected)} as HarnessApi:undefined
  const refresh=async()=>{setReviewing(true);setError('');try{await api.customPreviewFork(appId,version,fork?.id,fork?.revision);setConfirmRefresh(false);await load()}catch(e){setError(String(e))}finally{setReviewing(false)}}
  const primary=fork?.entities.find(e=>e.key==='primary')
  // Do not let generated code read production before its private snapshot loads.
  if(loadedAppId!==appId)return error?<p role="alert">{error}<button onClick={()=>void load()}>{t('Reload')}</button></p>:<p role="status">{t('Loading preview database…')}</p>
  return <><p>{fork?t('Preview database (production data is unchanged)'):t('Read-only preview')}</p>{error&&<p role="alert">{error}</p>}{!fork&&<button type="button" className="pill-btn quiet" disabled={reviewing} onClick={()=>void refresh()}>{reviewing?t('Creating preview database…'):t('Create preview database')}</button>}{staleSchema&&<div role="alert"><p>{t('The production app database schema changed after this preview was created. Recreate the preview database and review the preview again before publishing.')}</p><p>{t('Recreating it replaces records saved only in this preview. Production records are unchanged.')}</p>{!confirmRefresh?<button type="button" className="pill-btn quiet" disabled={reviewing} onClick={()=>setConfirmRefresh(true)}>{t('Recreate preview database')}</button>:<section role="alertdialog" aria-label={t('Recreate preview database')}><p>{t('Replace preview-only records and create a preview database from the current production schema.')}</p><button type="button" disabled={reviewing} onClick={()=>setConfirmRefresh(false)}>{t('Cancel')}</button><button type="button" disabled={reviewing} onClick={()=>void refresh()}>{reviewing?t('Creating…'):t('Replace and create')}</button></section>}</div>}{fork&&!fork.mergedAt&&<div className="hx-actions"><button type="button" className="pill-btn quiet" disabled={!canReview||reviewing||staleSchema} onClick={()=>void (async()=>{setReviewing(true);try{await onCandidate(fork.id,fork.revision)}catch(e){setError(String(e))}finally{setReviewing(false)}})()}>{reviewing?t('Checking…'):candidate?.current&&candidate.forkRevision===fork.revision?t('This preview has been reviewed'):t('Mark this preview as reviewed')}</button>{candidate&&!candidate.current&&!staleSchema&&<span role="status">{t('The preview is out of date. Review it again.')}</span>}</div>}<AppViewportPreview><CustomAppFrame html={html} httpBase={httpBase} table={primary?.table||table} rows={primary?.rows||rows} api={adapter} previewEntities={fork?.entities} /></AppViewportPreview></>
}
