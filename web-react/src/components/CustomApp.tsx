import React, { useEffect, useRef, useState } from 'react'
import { useAppearance } from '../utils/appearance'
import type { App, AppAction, AppConnection, AppFork, HarnessApi, Row, Table } from '../utils/harness'

// Two opaque-origin frames isolate generated code and its navigation.
export function CustomAppFrame({ html, table, rows, httpBase, api, reload, appId }: { appId?: string; html: string; table: Table; rows: Row[]; httpBase: string; api?: HarnessApi; reload?: () => unknown }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const { theme } = useAppearance()
  type Change = { targetTable?: Table; action?: AppAction; connection?: AppConnection; gatewayId?: string; before?: Row; expectedUpdatedAt?: string; id: string; operation: string; args: { id?: string; values?: Record<string, unknown>; input?: unknown; body?: Record<string,unknown>; entity?: string; name?: string; gatewayId?: string } }
  const [change, setChange] = useState<Change | null>(null)
  const pending = useRef<Change | null>(null)
  const [working, setWorking] = useState(false)
  useEffect(()=>{pending.current=null;setChange(null)},[html,theme,appId])
  const reply = (id: string, value?: unknown, error?: string) => frame.current?.contentWindow?.postMessage({ type: 'honmaru:result', id, value, error }, '*')
  async function decide(approved: boolean) {
    const current = pending.current
    if (!current || working) return
    setWorking(true)
    try {
      if (!approved) { reply(current.id, undefined, 'The user declined this change.'); return }
      if (!api) throw new Error('Preview is read-only.')
      const targetTable = current.targetTable || table
      const row = current.before || rows.find(r => r.id === current.args.id)
      let result
      if(current.operation === 'run' && current.action && appId) result = await api.actionChange(appId,{action:'run',name:current.action.name,version:current.action.publishedVersion,gatewayId:current.gatewayId,input:current.args.input,requestId:current.id})
      else if(current.operation === 'connect' && current.connection && appId) result = await api.connectionChange(appId,{action:'request',name:current.connection.name,version:current.connection.version,body:current.args.body,requestId:current.id})
      else
      if (current.operation === 'create') result = await api.addRow(targetTable.id, current.args.values || {}, 'strict')
      else {
        if (!row) throw new Error('No such row in this app.')
        result = current.operation === 'update' ? await api.updateRow(targetTable.id, row.id, current.args.values || {}, current.expectedUpdatedAt, 'strict') : await api.deleteRow(targetTable.id, row.id, current.expectedUpdatedAt)
      }
      reply(current.id, result)
      await reload?.()
    } catch (e) { reply(current.id, undefined, e instanceof Error ? e.message : String(e)) }
    finally { pending.current = null; setChange(null); setWorking(false) }
  }

  useEffect(() => {
    const listener = async (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      if (event.data?.type === 'honmaru:ready') { frame.current?.contentWindow?.postMessage({ type: 'honmaru:init', html: `<meta name="color-scheme" content="${theme === 'system' ? 'light dark' : theme}"><style>body{background:Canvas;color:CanvasText}</style>${html}`, theme }, '*'); return }
      if (event.data?.type !== 'honmaru:request' || typeof event.data.id !== 'string' || event.data.id.length > 80) return
      const { id, operation, args } = event.data
      if (operation === 'read') { reply(id, { table, rows }); return }
      if (!api) { reply(id, undefined, 'Preview is read-only.'); return }
      let size = Infinity
      try { size = JSON.stringify(args).length } catch { /* cyclic input is invalid */ }
      if (!['create', 'update', 'remove', 'entity', 'run', 'connect', 'job'].includes(operation) || !args || typeof args !== 'object' || size > 20000) { reply(id, undefined, 'Invalid request.'); return }
      if (pending.current) { reply(id, undefined, 'Another change is awaiting approval.'); return }
      // Reserve the approval slot before asynchronous capability discovery.
      const request: Change = { id, operation, args }
      pending.current = request
      try {
        if(['run','connect','job','entity'].includes(operation) || args.entity && args.entity !== 'primary') {
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
            if(operation==='entity'){reply(id,data);pending.current=null;return}
            request.targetTable=entity.table
            request.before=data.rows.find(r=>r.id===args.id)
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
  }, [table, rows, html, theme, api, appId])
  const labeled = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([id, value]) => [(change?.targetTable || table).columns.find(c => c.id === id)?.name || id, value]))
  if (html.length > 119800) return <p role="alert">表示できるコードの上限は119800文字です。コードを短くして保存してください。</p>
  return <>{change && <div className="hx-custom-approval" role="alertdialog" aria-label="アプリのデータ変更を確認"><h3>{change.action ? 'サーバー処理の実行確認' : change.connection ? '外部API読み取りの確認' : 'データ変更の確認'}</h3><p>{change.targetTable?.name || table.name} · {change.operation === 'create' ? '行を追加' : change.operation === 'update' ? '行を更新' : change.operation === 'run' ? 'サーバー処理' : change.operation === 'connect' ? '外部API' : '行を削除'}</p><pre>{JSON.stringify(change.action ? {処理:change.action.name,公開版:change.action.publishedVersion,コード:change.action.published,入力:change.args.input,実行ノード:change.gatewayId} : change.connection ? {接続:change.connection.name,URL:change.connection.endpoint,操作:change.connection.method||'GET',送信内容:change.args.body||null} : { ...(change.before ? { '対象レコード': change.before.id, '変更前': labeled(change.before.values) } : {}), ...(change.operation !== 'remove' ? { '変更内容': labeled(change.args.values || {}) } : {}) }, null, 2)}</pre><button disabled={working} onClick={() => void decide(false)}>キャンセル</button><button disabled={working} onClick={() => void decide(true)}>この変更を許可</button></div>}<iframe ref={frame} title="カスタムアプリ" sandbox="allow-scripts" referrerPolicy="no-referrer" key={html + theme} src={`${httpBase}/custom-app-runner`} className="hx-custom-frame" /></>
}
export function CustomAppEditor({ app, table, rows, api, reload, httpBase }: { app: App; table: Table; rows: Row[]; api: HarnessApi; reload: () => unknown; httpBase: string }) {
  const [html, setHtml] = useState(app.definition.custom?.draft || '')
  const [prompt, setPrompt] = useState('')
  const [preview, setPreview] = useState(Boolean(app.definition.custom?.draft))
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [history, setHistory] = useState<Array<{version: number; note: string | null}>>([])
  useEffect(() => { setHtml(app.definition.custom?.draft || '') }, [app.id, app.definition.custom?.draft])
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const changed = html !== (app.definition.custom?.draft || '')
  return <section className="hx-custom-editor">
    <h2>カスタムアプリ</h2><p>HTML・CSS・JavaScriptで独自の画面を作成できます。検証DBを作成するとプレビュー内で本番と分離した書き込みを試せます。未作成時は読み取り専用です。公開後のデータ変更は毎回確認します。保存した下書きを確認して公開してください。</p>
    <form onSubmit={e => { e.preventDefault(); void run(async () => { const result = await api.generateCustom(app.id, prompt); setHtml(result.html); setPreview(true) }) }}>
      <textarea aria-label="作りたいカスタムアプリ" placeholder="例：期限が近いタスクを強調するダッシュボード。担当者で絞り込み、進捗率を表示。" value={prompt} maxLength={4000} onChange={e => setPrompt(e.target.value)} />
      <button className="pill-btn" disabled={busy || !prompt.trim()}>{busy ? '処理中…' : '自然文からコードを生成'}</button>
    </form>
    {error && <p role="alert" className="form-error">{error}</p>}
    <details className="hx-custom-source"><summary>コードを編集</summary><label>HTML / CSS / JavaScript<textarea className="hx-code-editor" aria-label="カスタムアプリのソース" value={html} maxLength={119800} spellCheck={false} onChange={e => { setHtml(e.target.value); setPreview(false) }} /></label></details>
    <div className="hx-actions">
      <button className="pill-btn quiet" disabled={!html || busy} onClick={() => setPreview(v => !v)}>{preview ? 'プレビューを閉じる' : 'プレビュー'}</button>
      <button className="pill-btn" disabled={busy || !html || !changed} onClick={() => void run(async () => { await api.saveCustom(app.id, 'draft', app.version, html); await reload() })}>下書きを保存</button>
      <button className="pill-btn" disabled={busy || changed || !html || html === app.definition.custom?.published} onClick={() => void run(async () => { await api.saveCustom(app.id, 'publish', app.version); await reload() })}>保存した下書きを公開</button>
      {app.definition.custom?.published && <button className="pill-btn quiet" disabled={busy} onClick={() => void run(async () => { await api.saveCustom(app.id, 'unpublish', app.version); await reload() })}>公開を停止</button>}
    </div>
    <details onToggle={e => { if (e.currentTarget.open) void api.versions(app.id).then(r => setHistory(r.versions)).catch(e => setError(String(e))) }}><summary>コードの履歴</summary>{history.filter(v => v.note?.startsWith('Custom app:')).map(v => <p key={v.version}>v{v.version} · {v.note} <button className="pill-btn quiet" disabled={busy} onClick={() => void run(async () => { await api.saveCustom(app.id, 'restore', app.version, undefined, v.version); await reload() })}>下書きに復元</button></p>)}</details>
    <small>{changed ? '未保存の変更があります' : `バージョン ${app.version}`} · 外部通信なし · アプリの閲覧権限を継承 · 公開操作は監査ログに記録</small>
    {preview && <ForkPreview appId={app.id} api={api} httpBase={httpBase} html={html} table={table} rows={rows} />}
  </section>
}

function ForkPreview({appId,api,httpBase,html,table,rows}:{appId:string;api:HarnessApi;httpBase:string;html:string;table:Table;rows:Row[]}) {
  const [fork,setFork]=useState<AppFork|null>(null)
  const [error,setError]=useState('')
  const current=useRef<AppFork|null>(null)
  const load=async()=>{try{const d=await api.appDatabase(appId);current.current=d.fork;setFork(d.fork)}catch(e){setError(String(e))}}
  useEffect(()=>{void load()},[appId,api])
  const mutate=async(operation:string,values?:Record<string,unknown>,rowId?:string,expectedUpdatedAt?:string)=>{
    const f=current.current;if(!f)throw new Error('No preview database.')
    const r=await api.databaseChange(appId,{action:'fork_write',forkId:f.id,revision:f.revision,entity:'primary',operation,values,rowId,expectedUpdatedAt})
    await load();return r.result
  }
  const adapter=fork?{addRow:(_:string,v:Record<string,unknown>)=>mutate('create',v),updateRow:(_:string,id:string,v:Record<string,unknown>,expected?:string)=>mutate('update',v,id,expected),deleteRow:(_:string,id:string,expected?:string)=>mutate('remove',undefined,id,expected)} as HarnessApi:undefined
  const primary=fork?.entities.find(e=>e.key==='primary')
  return <><p>{fork?'検証DBのプレビュー（本番データは変更しません）':'読み取り専用プレビュー · 実行基盤 → データベースから検証DBを作成できます。'}</p>{error&&<p role="alert">{error}</p>}<CustomAppFrame html={html} httpBase={httpBase} table={primary?.table||table} rows={primary?.rows||rows} api={adapter} /></>
}
