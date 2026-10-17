import React, { useEffect, useRef, useState } from 'react'
import { CustomAppFrame } from './CustomApp'
import { cellText, type App, type HarnessApi } from '../utils/harness'

/** Render the actual published app or its table, with no mutation capabilities. */
export function HarnessAppPreview({ app, api, httpBase }: { app: App; api: HarnessApi; httpBase: string }) {
  const host = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [data, setData] = useState<Awaited<ReturnType<HarnessApi['app']>> | null>(null)
  const [error, setError] = useState(false)
  useEffect(() => {
    if (!host.current) return
    if (typeof IntersectionObserver === 'undefined') { setVisible(true); return }
    const observer = new IntersectionObserver(([entry]) => setVisible(entry.isIntersecting), { rootMargin: '80px' })
    observer.observe(host.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    let live = true
    setData(null); setError(false)
    if (visible) api.app(app.id).then(result => { if (live) setData(result) }).catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [app.id, app.version, api, visible])
  return <span ref={host} className="hx-app-live-preview" aria-hidden="true">
    {error ? <span className="hx-preview-state">プレビューを読み込めません</span> : !data ? <span className="hx-preview-state">プレビューを読み込み中…</span> : <span className="hx-preview-viewport">
      {data.app.definition.custom?.published ? <CustomAppFrame decorative html={data.app.definition.custom.published} table={data.table} rows={data.rows} httpBase={httpBase} /> : <span className="hx-preview-table-surface">
        <strong>{data.table.name}</strong>
        <table className="hx-table"><thead><tr>{data.table.columns.slice(0, 6).map(column => <th key={column.id}>{column.name}</th>)}</tr></thead><tbody>{data.rows.slice(0, 6).map(row => <tr key={row.id}>{data.table.columns.slice(0, 6).map(column => <td key={column.id}>{cellText(column, row.values[column.id]) || '—'}</td>)}</tr>)}</tbody></table>
        {!data.rows.length && <span className="hx-preview-table-empty"><b>レコードがありません</b><span>この表示に一致するレコードはありません。</span></span>}
      </span>}
    </span>}
  </span>
}
