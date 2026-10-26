import React, { useEffect, useRef, useState } from 'react'
import { CustomAppFrame } from './CustomApp'
import { cellText, type App, type AppEntity, type HarnessApi, type Row } from '../utils/harness'

type RelationEntity=AppEntity & {rows:Row[]}
function previewCellText(column:{id:string;type:string;targetEntity?:string},value:unknown,entities:RelationEntity[]){
  if(column.type!=='relation')return cellText(column as Parameters<typeof cellText>[0],value)
  const target=entities.find(entity=>entity.key===column.targetEntity)
  const label=(id:string)=>{const row=target?.rows.find(item=>item.id===id),title=target?.table.columns[0];return row&&title?cellText(title,row.values[title.id])||row.id:id}
  return (Array.isArray(value)?value:value==null?[]:[value]).map(id=>label(String(id))).join(', ')
}

/** Render the actual published app or its table, with no mutation capabilities. */
export function HarnessAppPreview({ app, api, httpBase }: { app: App; api: HarnessApi; httpBase: string }) {
  const host = useRef<HTMLSpanElement>(null)
  const [visible, setVisible] = useState(false)
  const [data, setData] = useState<(Awaited<ReturnType<HarnessApi['app']>> & {relationEntities?:RelationEntity[]}) | null>(null)
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
    if (visible) api.app(app.id).then(async result => {
      const targetKeys=new Set(result.table.columns.filter(column=>column.type==='relation'&&column.targetEntity).map(column=>column.targetEntity!))
      if(!targetKeys.size||typeof api.appDatabase!=='function'){if(live)setData(result);return}
      const database=await api.appDatabase(app.id).catch(()=>null)
      const relationEntities=await Promise.all((database?.entities||[]).filter(entity=>targetKeys.has(entity.key)).map(async entity=>{
        if(entity.key==='primary')return {...entity,rows:result.rows}
        try{return {...entity,rows:(await api.entityRows(entity.table.id)).rows}}catch{return {...entity,rows:[]}}
      }))
      if(live)setData({...result,relationEntities})
    }).catch(() => { if (live) setError(true) })
    return () => { live = false }
  }, [app.id, app.version, api, visible])
  return <span ref={host} className="hx-app-live-preview" aria-hidden="true">
    {error ? <span className="hx-preview-state">プレビューを読み込めません</span> : !data ? <span className="hx-preview-state">プレビューを読み込み中…</span> : <span className="hx-preview-viewport">
      <HarnessAppPreviewContent data={data} httpBase={httpBase}/>
    </span>}
  </span>
}


export function HarnessAppPreviewContent({data,httpBase}:{data:Awaited<ReturnType<HarnessApi['app']>> & {relationEntities?:RelationEntity[]};httpBase:string}) {
  return <>{data.app.definition.custom?.published ? <CustomAppFrame decorative html={data.app.definition.custom.published} table={data.table} rows={data.rows} httpBase={httpBase} /> : <span className="hx-preview-table-surface">
        <strong>{data.table.name}</strong>
        <table className="hx-table"><thead><tr>{data.table.columns.slice(0, 6).map(column => <th key={column.id}>{column.name}</th>)}</tr></thead><tbody>{data.rows.slice(0, 6).map(row => <tr key={row.id}>{data.table.columns.slice(0, 6).map(column => <td key={column.id}>{previewCellText(column, row.values[column.id],data.relationEntities||[]) || '—'}</td>)}</tr>)}</tbody></table>
        {!data.rows.length && <span className="hx-preview-table-empty"><b>レコードがありません</b><span>この表示に一致するレコードはありません。</span></span>}
      </span>}</>
}
