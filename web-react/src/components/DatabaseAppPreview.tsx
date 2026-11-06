import React from 'react'
import { cellText, type App, type Column, type Row, type Table } from '../utils/harness'
import { HarnessAppIcon } from './HarnessAppIcon'
import { Icon } from './Icon'

const PREVIEW_ROW_LIMIT = 6
const PREVIEW_COLUMN_LIMIT = 5

/** Read-only table preview for database-backed Apps in desktop and phone layouts. */
export function DatabaseAppPreview({ app, table, rows, renderCell, onBrowseData }: {
  app: App
  table: Table
  rows: Row[]
  renderCell?: (column: Column, row: Row) => string
  onBrowseData?: () => void
}) {
  const columns = table.columns.slice(0, PREVIEW_COLUMN_LIMIT)
  const value = (column: Column, row: Row) => renderCell ? renderCell(column, row) : cellText(column, row.values[column.id])
  const title = (row: Row) => columns[0] ? value(columns[0], row).trim() || row.id : row.id
  const emptyState = () => <div className="hx-database-preview-empty"><Icon name="list-check" size={22} /><strong>レコードはまだありません</strong><span>データビューアーからレコードを追加できます。</span></div>
  return <section className="hx-database-app-preview" aria-label={`${app.name}のデータプレビュー`}>
    <header className="hx-database-preview-header">
      <div className="hx-database-preview-title"><span><HarnessAppIcon icon={app.icon} size={18} /></span><div><strong>{app.name}</strong><small>{table.name}</small></div></div>
      <button type="button" className="hx-database-preview-browse" aria-label="データを開く" onClick={onBrowseData}><Icon name="list-check" size={14} />データを開く</button>
    </header>
    <div className="hx-database-preview-meta"><span>{rows.length} 件のレコード</span><span>{table.columns.length} フィールド</span></div>
    <div className="hx-database-preview-table-wrap">
      {columns.length > 0 && <table className="hx-database-preview-table"><thead><tr>{columns.map(column=><th key={column.id}>{column.name}</th>)}</tr></thead><tbody>
        {rows.slice(0,PREVIEW_ROW_LIMIT).map(row=><tr key={row.id}>{columns.map((column,index)=><td key={column.id}>{index===0?<strong>{title(row)}</strong>:value(column,row)||'—'}</td>)}</tr>)}
      </tbody></table>}
      {!rows.length && emptyState()}
      {rows.length>PREVIEW_ROW_LIMIT&&<span className="hx-database-preview-more">先頭 {PREVIEW_ROW_LIMIT} 件を表示 · 全 {rows.length} 件</span>}
    </div>
    <div className="hx-database-preview-mobile">
      {rows.length ? rows.slice(0,PREVIEW_ROW_LIMIT).map(row=><article className="hx-database-preview-card" key={row.id}>
        <strong className="hx-database-preview-card-title">{title(row)}</strong>
        {columns.slice(1,4).map(column=><div className="hx-database-preview-card-field" key={column.id}><span>{column.name}</span><span>{value(column,row)||'—'}</span></div>)}
      </article>) : emptyState()}
      {rows.length>PREVIEW_ROW_LIMIT&&<span className="hx-database-preview-more">先頭 {PREVIEW_ROW_LIMIT} 件を表示 · 全 {rows.length} 件</span>}
    </div>
  </section>
}
