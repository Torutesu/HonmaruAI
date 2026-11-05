import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useAppearance } from '../utils/appearance'
import type { App, AppAction, AppConnection, AppFork, AppEntity, HarnessApi, Row, Table } from '../utils/harness'

import {MAX_PREVIEW_SOURCE} from '../utils/customAppLimits'

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
export function CustomAppFrame({ html, table, rows, httpBase, api, reload, appId, previewEntities, decorative = false }: { decorative?: boolean; previewEntities?: Array<AppEntity & {rows:Row[]}>; appId?: string; html: string; table: Table; rows: Row[]; httpBase: string; api?: HarnessApi; reload?: () => unknown }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const initialized = useRef(false)
  const renderId = useRef('')
  const [attempt, setAttempt] = useState(0)
  const [renderState, setRenderState] = useState<'loading' | 'ready' | 'failed'>('loading')
  const { theme } = useAppearance()
  type Change = { targetWindow?: Window | null; targetTable?: Table; action?: AppAction; connection?: AppConnection; gatewayId?: string; before?: Row; expectedUpdatedAt?: string; id: string; operation: string; args: { id?: string; values?: Record<string, unknown>; input?: unknown; body?: Record<string,unknown>; entity?: string; name?: string; gatewayId?: string } }
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
      if (!api) { reply(id, undefined, 'Preview is read-only.'); return }
      let size = Infinity
      try { size = JSON.stringify(args).length } catch { /* cyclic input is invalid */ }
      if (!['create', 'update', 'remove', 'entity', 'run', 'connect', 'job'].includes(operation) || !args || typeof args !== 'object' || size > 20000) { reply(id, undefined, 'Invalid request.'); return }
      if (pending.current) { reply(id, undefined, 'Another change is awaiting approval.'); return }
      // Reserve the approval slot before asynchronous capability discovery.
      const request: Change = { id, operation, args, targetWindow:frame.current?.contentWindow }
      pending.current = request
      try {
        if(['run','connect','job','entity'].includes(operation) || args.entity && args.entity !== 'primary') {
          if(previewEntities && args.entity && !['run','connect','job'].includes(operation)) {
            const entity=previewEntities.find(e=>e.key===args.entity);if(!entity)throw new Error('No such preview entity.');request.targetTable=entity.table;request.before=entity.rows.find(r=>r.id===args.id)
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
  }, [table, rows, html, theme, api, appId, previewEntities, httpBase, attempt])
  const labeled = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([id, value]) => [(change?.targetTable || table).columns.find(c => c.id === id)?.name || id, value]))
  if (html.length > MAX_PREVIEW_SOURCE) return <p role="alert">表示できるコードの上限は119800文字です。コードを短くして保存してください。</p>
  return <>{change && <div className="hx-custom-approval" role="alertdialog" aria-label="アプリのデータ変更を確認"><h3>{change.action ? 'サーバー処理の実行確認' : change.connection ? '外部API読み取りの確認' : 'データ変更の確認'}</h3><p>{change.targetTable?.name || table.name} · {change.operation === 'create' ? '行を追加' : change.operation === 'update' ? '行を更新' : change.operation === 'run' ? 'サーバー処理' : change.operation === 'connect' ? '外部API' : '行を削除'}</p><pre>{JSON.stringify(change.action ? {処理:change.action.name,公開版:change.action.publishedVersion,コード:change.action.published,入力:change.args.input,実行ノード:change.gatewayId} : change.connection ? {接続:change.connection.name,URL:change.connection.endpoint,操作:change.connection.method||'GET',送信内容:change.args.body||null} : { ...(change.before ? { '対象レコード': change.before.id, '変更前': labeled(change.before.values) } : {}), ...(change.operation !== 'remove' ? { '変更内容': labeled(change.args.values || {}) } : {}) }, null, 2)}</pre><button disabled={working} onClick={() => decide(false)}>キャンセル</button><button disabled={working} onClick={() => decide(true)}>この変更を許可</button></div>}{renderState !== 'ready' && <div className="hx-custom-status" role="status">{renderState === 'loading' ? 'アプリを読み込んでいます…' : <><span>アプリを表示できませんでした。</span><button type="button" onClick={() => setAttempt(value => value + 1)}>再試行</button></>}</div>}<iframe tabIndex={decorative ? -1 : undefined} ref={frame} onLoad={() => initialize()} title="カスタムアプリ" sandbox="allow-scripts" referrerPolicy="no-referrer" key={`${html}:${theme}:${appId}:${httpBase}:${attempt}`} src={`${httpBase}/custom-app-runner?v=4`} className="hx-custom-frame" /></>
}
export function CustomAppEditor({ app, table, rows, api, reload, httpBase }: { app: App; table: Table; rows: Row[]; api: HarnessApi; reload: () => unknown; httpBase: string }) {
  const scope=useMemo(()=>({}),[app.id,api]),activeScope=useRef<object|null>(scope);activeScope.current=scope
  const [html, setHtml] = useState(app.definition.custom?.draft || '')
  const htmlRef=useRef(html),editGeneration=useRef(0),remote=useRef({scope,draft:app.definition.custom?.draft||'',generation:0}),pending=useRef<{scope:object}|null>(null)
  const [shownScope,setShownScope]=useState(scope),[generated,setGenerated]=useState<{html:string;prompt:string;startingHtml:string;contextGeneration:number;version:number}|null>(null),[remoteChanged,setRemoteChanged]=useState(false)
  const promptGeneration=useRef(0),context=JSON.stringify([app.version,app.definition.custom?.draft||'',table.id,table.columns]),contextRef=useRef(context),contextGeneration=useRef(0)
  if(contextRef.current!==context){contextRef.current=context;contextGeneration.current++}
  const [prompt, setPrompt] = useState('')
  const [preview, setPreview] = useState(Boolean(app.definition.custom?.draft))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<Array<{version: number; note: string | null}>>([])
  const [commitState,setCommitState]=useState<Awaited<ReturnType<typeof api.customCommitState>>|null>(null)
  const [gitOwner,setGitOwner]=useState(''),[gitRepo,setGitRepo]=useState(''),[gitBranch,setGitBranch]=useState('main'),[gitSha,setGitSha]=useState('')
  const [hosting,setHosting]=useState<Awaited<ReturnType<typeof api.appHosting>>|null>(null)
  const [domainHostname,setDomainHostname]=useState(''),[publicDataConfirmed,setPublicDataConfirmed]=useState(false),[hostingError,setHostingError]=useState('')
  useLayoutEffect(()=>{
    activeScope.current=scope
    const draft=app.definition.custom?.draft||''
    htmlRef.current=draft;editGeneration.current++;remote.current={scope,draft,generation:editGeneration.current};promptGeneration.current++;pending.current=null
    setHtml(draft);setPrompt('');setPreview(Boolean(draft));setGenerated(null);setRemoteChanged(false);setBusy(false);setError('');setHistory([]);setShownScope(scope)
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
  const changed = html !== (app.definition.custom?.draft || '')
  const currentRemote=app.definition.custom?.draft||''
  const remoteConflict=remoteChanged||(remote.current.scope===scope&&remote.current.draft!==currentRemote&&(htmlRef.current!==remote.current.draft||editGeneration.current!==remote.current.generation)&&htmlRef.current!==currentRemote)
  if(shownScope!==scope)return <section className="hx-custom-editor" role="status">アプリを読み込んでいます…</section>
  return <section className="hx-custom-editor">
    <h2>カスタムアプリ</h2><p>HTML・CSS・JavaScriptで独自の画面を作成できます。検証DBを作成するとプレビュー内で本番と分離した書き込みを試せます。未作成時は読み取り専用です。公開後のデータ変更は毎回確認します。保存した下書きを確認して公開してください。</p>
    <form onSubmit={e => { e.preventDefault();if(generated!==null||!prompt.trim())return;const started=editGeneration.current,startedPrompt=promptGeneration.current,startedContext=contextGeneration.current,startedConflict=remoteConflict,request=prompt,version=app.version,startingHtml=htmlRef.current;void run(async () => { const result = await api.generateCustom(app.id, request);if(activeScope.current!==scope)return;if(typeof result?.html!=='string'||!result.html.trim()||result.html.length>120000)throw new Error('生成結果を確認できません。現在のコードは保持されています。');if(startedConflict||editGeneration.current!==started||promptGeneration.current!==startedPrompt||contextGeneration.current!==startedContext)setGenerated({html:result.html,prompt:request,startingHtml,contextGeneration:startedContext,version});else{htmlRef.current=result.html;editGeneration.current++;setHtml(result.html);setPreview(true)} }) }}>
      <textarea aria-label="作りたいカスタムアプリ" placeholder="例：期限が近いタスクを強調するダッシュボード。担当者で絞り込み、進捗率を表示。" value={prompt} maxLength={4000} onChange={e => {promptGeneration.current++;setPrompt(e.target.value)}} />
      <button className="pill-btn" disabled={busy || generated!==null || !prompt.trim()}>{busy ? '処理中…' : '自然文からコードを生成'}</button>
    </form>
    {error && <p role="alert" className="form-error">{error}</p>}
    {remoteConflict&&<section aria-label="保存済みコードの変更"><p role="status">保存済みのコードが変更されました。編集中のコードは保持しています。保存前に内容を確認してください。</p><label>現在保存されているコード<textarea className="hx-code-editor" aria-label="現在保存されているコード" value={currentRemote} readOnly rows={6}/></label><div className="hx-actions"><button type="button" className="pill-btn quiet" onClick={()=>{if(!window.confirm('編集中のコードを破棄して、現在保存されているコードを使いますか？'))return;htmlRef.current=currentRemote;editGeneration.current++;remote.current={scope,draft:currentRemote,generation:editGeneration.current};setHtml(currentRemote);setPreview(false);setRemoteChanged(false)}}>保存済みコードを使う</button><button type="button" className="pill-btn quiet" onClick={()=>{if(!window.confirm('編集中のコードを保持します。次に保存すると現在保存されているコードを上書きします。続けますか？'))return;setRemoteChanged(false)}}>編集中のコードで続ける</button></div></section>}
    <details className="hx-custom-source"><summary>コードを編集</summary><label>HTML / CSS / JavaScript<textarea className="hx-code-editor" aria-label="カスタムアプリのソース" value={html} maxLength={119800} spellCheck={false} onChange={e => {htmlRef.current=e.target.value;editGeneration.current++;setHtml(e.target.value); setPreview(false) }} /></label></details>
    {generated!==null&&<section aria-label="生成結果を確認"><p role="status">生成中に入力またはアプリの状態が変更されたため、現在のコードは変更していません。生成結果を確認して選択してください。</p>{generated.contextGeneration!==contextGeneration.current&&<p role="status">生成時のバージョン {generated.version} からアプリの状態が変更されています。現在の状態に合うか確認してください。</p>}<label>生成開始時の編集中コード<textarea className="hx-code-editor" aria-label="生成開始時の編集中コード" value={generated.startingHtml} readOnly rows={6}/></label><label>送信した依頼<textarea aria-label="生成時の依頼" value={generated.prompt} readOnly rows={2}/></label><label>生成結果<textarea className="hx-code-editor" aria-label="生成されたコード" value={generated.html} readOnly rows={6}/></label><div className="hx-actions"><button type="button" className="pill-btn" onClick={()=>{const warning=generated.contextGeneration!==contextGeneration.current?`生成時のバージョン ${generated.version} からアプリの状態が変更されています。`:'';if(!window.confirm(`${warning}生成結果で編集中のコードを置き換えます。現在のコードは自動保存されません。続けますか？`))return;htmlRef.current=generated.html;editGeneration.current++;setHtml(generated.html);setGenerated(null);setPreview(true)}}>生成結果を採用</button><button type="button" className="pill-btn quiet" onClick={()=>setGenerated(null)}>生成結果を破棄し、現在のコードを残す</button></div></section>}
    <section className="hx-commit-release" aria-label="GitHubコミット公開">
      <h3>GitHubコミットから公開</h3>
      <p>接続中のGitHubアカウントから、固定したcommitのHTMLと静的アセットだけを取り込みます。公開範囲と保存済みバンドルに別のOwner/Adminの承認が必要です。ビルドやGitHubへの書き込みは行いません。</p>
      <div className="hx-form-grid">
        <label>Owner<input aria-label="GitHub owner" value={gitOwner} onChange={e=>setGitOwner(e.target.value)} /></label>
        <label>Repository<input aria-label="GitHub repository" value={gitRepo} onChange={e=>setGitRepo(e.target.value)} /></label>
        <label>Branch<input aria-label="GitHub branch" value={gitBranch} onChange={e=>setGitBranch(e.target.value)} /></label>
        <label>Full commit SHA<input aria-label="GitHub commit SHA" value={gitSha} onChange={e=>setGitSha(e.target.value)} /></label>
      </div>
      <button type="button" className="pill-btn quiet" disabled={busy||!gitOwner.trim()||!gitRepo.trim()||!gitBranch.trim()||!gitSha.trim()} onClick={()=>void run(async()=>{
        await api.customCommit(app.id,{action:'import_commit',owner:gitOwner.trim(),repo:gitRepo.trim(),branch:gitBranch.trim(),commitSha:gitSha.trim()})
        await reload()
        setCommitState(await api.customCommitState(app.id))
      })}>commitのHTMLと静的アセットを取り込む</button>
      {commitState?.commit&&<div className="hx-commit-review" aria-label="GitHub commit approval">
        <p>固定commit: <code>{commitState.commit.owner}/{commitState.commit.repo}@{commitState.commit.sha}</code> · {commitState.commit.assets.length} assets · SHA-256 {commitState.commit.sourceHash.slice(0,12)}…</p>
        <p>対象バージョン v{commitState.commit.appVersion} · 公開範囲 {commitState.scope?.visibility||'unknown'}{commitState.scope?.domainScope ? ' · domain '+commitState.scope.domainScope : ''}</p>
        {(!commitState.approval||['rejected','revoked'].includes(commitState.approval.status))&&<button type="button" className="pill-btn" disabled={busy||changed||remoteConflict} onClick={()=>void run(async()=>{
          await api.customCommit(app.id,{action:'request_commit_approval',version:app.version})
          setCommitState(await api.customCommitState(app.id))
        })}>このcommitの承認を依頼</button>}
        {commitState.approval&&<p role="status">承認状態: {commitState.approval.status} · v{commitState.approval.appVersion} · {commitState.approval.visibility}</p>}
        {commitState.approval?.status==='pending'&&<div className="hx-actions">
          <button type="button" className="pill-btn" disabled={busy} onClick={()=>void run(async()=>{
            await api.customCommit(app.id,{action:'review_commit_approval',decision:'approve',approvalId:commitState.approval?.id,version:app.version,commitSha:commitState.approval?.commitSha,sourceHash:commitState.approval?.sourceHash})
            setCommitState(await api.customCommitState(app.id))
          })}>Owner/Adminとして承認</button>
          <button type="button" className="pill-btn quiet" disabled={busy} onClick={()=>void run(async()=>{
            await api.customCommit(app.id,{action:'review_commit_approval',decision:'reject',approvalId:commitState.approval?.id,version:app.version,commitSha:commitState.approval?.commitSha,sourceHash:commitState.approval?.sourceHash})
            setCommitState(await api.customCommitState(app.id))
          })}>却下</button>
        </div>}
        {commitState.approval?.status==='approved'&&<p>承認者本人以外の作成者またはOwner/Adminが公開できます。ブランチが移動すると、この承認は使用できません。</p>}
      </div>}
    </section>
    <section className="hx-commit-release" aria-label="カスタムドメイン公開">
      <h3>独自ドメインで公開</h3>
      <p>公開済みカスタムアプリを独自ドメインに接続できます。接続すると、そのドメインを知っている人はカスタム画面と全レコードを閲覧できます。アプリのワークスペース内共有設定とは別の公開許可です。</p>
      {hostingError&&<p role="alert" className="form-error">{hostingError}</p>}
      {hosting?.domain
        ? <div><p role="status">{hosting.domain.hostname} · {hosting.domain.status}</p><button type="button" className="pill-btn quiet" disabled={busy} onClick={()=>void run(async()=>{await api.changeAppHosting(app.id,{action:'remove'});setHosting(await api.appHosting(app.id));setPublicDataConfirmed(false)})}>独自ドメインを解除</button></div>
        : <div className="hx-form-grid">
          <label>完全なホスト名<input aria-label="独自ドメインのホスト名" value={domainHostname} onChange={e=>setDomainHostname(e.target.value)} placeholder="app.example.com" /></label>
          <label className="hx-domain-confirm"><input type="checkbox" aria-label="全レコードの公開を確認" checked={publicDataConfirmed} onChange={e=>setPublicDataConfirmed(e.target.checked)} />このドメインではカスタム画面と全レコードを誰でも閲覧できます。公開してよいことを確認しました。</label>
          <button type="button" className="pill-btn" disabled={busy||!hosting?.configured||!domainHostname.trim()||!publicDataConfirmed||!app.definition.custom?.published} onClick={()=>void run(async()=>{await api.changeAppHosting(app.id,{action:'attach',hostname:domainHostname.trim(),publicDataConfirmed:true});setHosting(await api.appHosting(app.id));setPublicDataConfirmed(false)})}>独自ドメインを追加</button>
          {hosting&&!hosting.configured&&<p role="status">独自ドメイン管理はこの環境で設定されていません。</p>}
        </div>}
    </section>
    <div className="hx-actions">
      <button className="pill-btn quiet" disabled={!html || busy} onClick={() => setPreview(v => !v)}>{preview ? 'プレビューを閉じる' : 'プレビュー'}</button>
      <button className="pill-btn" disabled={busy || remoteConflict || !html || !changed} onClick={() => {if(remoteConflict)return;void run(async () => { await api.saveCustom(app.id, 'draft', app.version, html); if(activeScope.current===scope)await reload() })}}>下書きを保存</button>
      <button className="pill-btn" disabled={busy || remoteConflict || changed || !html || html.length > MAX_PREVIEW_SOURCE || html === app.definition.custom?.published || Boolean(commitState?.commit && commitState.approval?.status!=='approved')} onClick={() => {if(remoteConflict||html.length > MAX_PREVIEW_SOURCE)return;void run(async () => { if(commitState?.commit){await api.customCommit(app.id,{action:'publish_commit',version:app.version,approvalId:commitState.approval?.id})}else{await api.saveCustom(app.id, 'publish', app.version)} if(activeScope.current===scope)await reload();setCommitState(await api.customCommitState(app.id)) })}}>{commitState?.commit?'承認済みGitHub commitを公開':'保存した下書きを公開'}</button>
      {app.definition.custom?.published && <button className="pill-btn quiet" disabled={busy} onClick={() => void run(async () => { await api.saveCustom(app.id, 'unpublish', app.version); if(activeScope.current===scope)await reload() })}>公開を停止</button>}
    </div>
    {html.length > MAX_PREVIEW_SOURCE && <p role="alert" className="form-error">プレビューして公開するには、コードを119800文字以下に短くしてください。下書きは保持されます。</p>}
    <details onToggle={e => { if (e.currentTarget.open) void api.versions(app.id).then(r => {if(activeScope.current===scope)setHistory(r.versions)}).catch(e => {if(activeScope.current===scope)setError(String(e))}) }}><summary>コードの履歴</summary>{history.filter(v => v.note?.startsWith('Custom app:')).map(v => <p key={v.version}>v{v.version} · {v.note} <button className="pill-btn quiet" disabled={busy} onClick={() => void run(async () => { await api.saveCustom(app.id, 'restore', app.version, undefined, v.version); if(activeScope.current===scope)await reload() })}>下書きに復元</button></p>)}</details>
    <small>{changed ? '未保存の変更があります' : `バージョン ${app.version}`} · 直接の外部通信なし・接続は確認付き · アプリの閲覧権限を継承 · 公開操作は監査ログに記録</small>
    {preview && <ForkPreview appId={app.id} api={api} httpBase={httpBase} html={html} table={table} rows={rows} />}
  </section>
}

function ForkPreview({appId,api,httpBase,html,table,rows}:{appId:string;api:HarnessApi;httpBase:string;html:string;table:Table;rows:Row[]}) {
  const [fork,setFork]=useState<AppFork|null>(null)
  const [loadedAppId,setLoadedAppId]=useState('')
  const [error,setError]=useState('')
  const current=useRef<AppFork|null>(null)
  const load=async()=>{try{setError('');const d=await api.appDatabase(appId);current.current=d.fork;setFork(d.fork);setLoadedAppId(appId)}catch(e){setError(String(e))}}
  useEffect(()=>{void load()},[appId,api])
  const mutate=async(tableId:string,operation:string,values?:Record<string,unknown>,rowId?:string,expectedUpdatedAt?:string)=>{
    const f=current.current;if(!f)throw new Error('No preview database.')
    const entity=f.entities.find(e=>e.table.id===tableId);if(!entity)throw new Error('No such preview entity.')
    const r=await api.databaseChange(appId,{action:'fork_write',forkId:f.id,revision:f.revision,entity:entity.key,operation,values,rowId,expectedUpdatedAt})
    await load();return operation==='remove'?r.result:{row:r.result}
  }
  const adapter=fork&&!fork.mergedAt?{addRow:(t:string,v:Record<string,unknown>)=>mutate(t,'create',v),updateRow:(t:string,id:string,v:Record<string,unknown>,expected?:string)=>mutate(t,'update',v,id,expected),deleteRow:(t:string,id:string,expected?:string)=>mutate(t,'remove',undefined,id,expected)} as HarnessApi:undefined
  const primary=fork?.entities.find(e=>e.key==='primary')
  // Do not let generated code read production before its private snapshot loads.
  if(loadedAppId!==appId)return error?<p role="alert">{error}<button onClick={()=>void load()}>再読み込み</button></p>:<p role="status">検証DBを読み込み中…</p>
  return <><p>{fork?'検証DBのプレビュー（本番データは変更しません）':'読み取り専用プレビュー · 実行基盤 → データベースから検証DBを作成できます。'}</p>{error&&<p role="alert">{error}</p>}<CustomAppFrame html={html} httpBase={httpBase} table={primary?.table||table} rows={primary?.rows||rows} api={adapter} previewEntities={fork?.entities} /></>
}
