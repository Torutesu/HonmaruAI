import React, { useEffect, useRef, useState } from 'react'
import { useAppearance } from '../utils/appearance'
import type { App, HarnessApi, Row, Table } from '../utils/harness'

// Two opaque-origin frames isolate generated code and its navigation.
export function CustomAppFrame({ html, table, rows, httpBase, api, reload }: { html: string; table: Table; rows: Row[]; httpBase: string; api?: HarnessApi; reload?: () => unknown }) {
  const frame = useRef<HTMLIFrameElement>(null)
  const { theme } = useAppearance()
  type Change = { before?: Row; expectedUpdatedAt?: string; id: string; operation: string; args: { id?: string; values?: Record<string, unknown> } }
  const [change, setChange] = useState<Change | null>(null)
  const pending = useRef<Change | null>(null)
  const [working, setWorking] = useState(false)
  const reply = (id: string, value?: unknown, error?: string) => frame.current?.contentWindow?.postMessage({ type: 'honmaru:result', id, value, error }, '*')
  async function decide(approved: boolean) {
    const current = pending.current
    if (!current || working) return
    setWorking(true)
    try {
      if (!approved) { reply(current.id, undefined, 'The user declined this change.'); return }
      if (!api) throw new Error('Preview is read-only.')
      const row = rows.find(r => r.id === current.args.id)
      let result
      if (current.operation === 'create') result = await api.addRow(table.id, current.args.values || {}, 'strict')
      else {
        if (!row) throw new Error('No such row in this app.')
        result = current.operation === 'update' ? await api.updateRow(table.id, row.id, current.args.values || {}, current.expectedUpdatedAt, 'strict') : await api.deleteRow(table.id, row.id, current.expectedUpdatedAt)
      }
      reply(current.id, result)
      await reload?.()
    } catch (e) { reply(current.id, undefined, e instanceof Error ? e.message : String(e)) }
    finally { pending.current = null; setChange(null); setWorking(false) }
  }

  useEffect(() => {
    const listener = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return
      if (event.data?.type === 'honmaru:ready') { frame.current?.contentWindow?.postMessage({ type: 'honmaru:init', html: `<meta name="color-scheme" content="${theme === 'system' ? 'light dark' : theme}"><style>body{background:Canvas;color:CanvasText}</style>${html}`, theme }, '*'); return }
      if (event.data?.type !== 'honmaru:request' || typeof event.data.id !== 'string' || event.data.id.length > 80) return
      const { id, operation, args } = event.data
      if (operation === 'read') { reply(id, { table, rows }); return }
      if (!api) { reply(id, undefined, 'Preview is read-only.'); return }
      let size = Infinity
      try { size = JSON.stringify(args).length } catch { /* cyclic input is invalid */ }
      if (!['create', 'update', 'remove'].includes(operation) || !args || typeof args !== 'object' || size > 20000) { reply(id, undefined, 'Invalid request.'); return }
      if (pending.current) { reply(id, undefined, 'Another change is awaiting approval.'); return }
      const row = rows.find(r => r.id === args.id)
      if (operation !== 'create' && !row) { reply(id, undefined, 'No such row in this app.'); return }
      const request = { id, operation, args, expectedUpdatedAt: row?.updatedAt, before: row }
      pending.current = request; setChange(request)
    }
    window.addEventListener('message', listener)
    return () => window.removeEventListener('message', listener)
  }, [table, rows, html, theme, api])
  const labeled = (values: Record<string, unknown>) => Object.fromEntries(Object.entries(values).map(([id, value]) => [table.columns.find(c => c.id === id)?.name || id, value]))
  if (html.length > 119800) return <p role="alert">表示できるコードの上限は119800文字です。コードを短くして保存してください。</p>
  return <>{change && <div className="hx-custom-approval" role="alertdialog" aria-label="アプリのデータ変更を確認"><h3>データ変更の確認</h3><p>{table.name} · {change.operation === 'create' ? '行を追加' : change.operation === 'update' ? '行を更新' : '行を削除'}</p><pre>{JSON.stringify({ ...(change.before ? { '対象レコード': change.before.id, '変更前': labeled(change.before.values) } : {}), ...(change.operation !== 'remove' ? { '変更内容': labeled(change.args.values || {}) } : {}) }, null, 2)}</pre><button disabled={working} onClick={() => void decide(false)}>キャンセル</button><button disabled={working} onClick={() => void decide(true)}>この変更を許可</button></div>}<iframe ref={frame} title="カスタムアプリ" sandbox="allow-scripts" referrerPolicy="no-referrer" key={html + theme} src={`${httpBase}/custom-app-runner`} className="hx-custom-frame" /></>
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
    <h2>カスタムアプリ</h2><p>HTML・CSS・JavaScriptで独自の画面を作成できます。プレビューは読み取り専用です。公開後のデータ変更は毎回確認します。保存した下書きを確認して公開してください。</p>
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
    {preview && <CustomAppFrame httpBase={httpBase} html={html} table={table} rows={rows} />}
  </section>
}
