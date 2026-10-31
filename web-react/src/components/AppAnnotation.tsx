import React, { useEffect, useRef, useState } from 'react'
import type {AppAnnotation} from '../utils/harness'
import {Icon} from './Icon'

export type AppAnnotationSelection = { target: string; x: number; y: number; rect?: {left:number;top:number;width:number;height:number} }

export function AppAnnotationMarkers({annotations,section,openId,onOpenChange}:{annotations:AppAnnotation[];section:'overview'|'data';openId:string|null;onOpenChange:(id:string|null)=>void}) {
  const visible=annotations.filter(annotation=>annotation.section===section&&!annotation.tableId&&!annotation.rowId)
  useEffect(()=>{if(openId&&!visible.some(annotation=>annotation.id===openId))onOpenChange(null)},[openId,visible.map(annotation=>annotation.id).join(':')])
  if(!visible.length)return null
  return <div className="hx-annotation-markers" aria-label="送信済みの画面注釈">
    {visible.map((annotation,index)=><div key={annotation.id} className={`hx-annotation-marker${annotation.x>72?' hx-annotation-marker-right':''}${annotation.y>70?' hx-annotation-marker-low':''}`} style={{left:`${annotation.x}%`,top:`${annotation.y}%`}}>
      <button type="button" className="hx-annotation-pin" aria-label={`注釈 ${index+1}: ${annotation.target} · ${annotation.authorName}`} aria-expanded={openId===annotation.id} onClick={()=>onOpenChange(openId===annotation.id?null:annotation.id)}>{index+1}</button>
      {openId===annotation.id&&<section className="hx-annotation-card" aria-label={`注釈: ${annotation.target}`}>
        <header><strong>{annotation.target}</strong><button type="button" aria-label="注釈を閉じる" onClick={()=>onOpenChange(null)}>×</button></header>
        <p>{annotation.body.replace(/(?:^|\n{1,2})注釈: [^\n]+\n/,'\n').trim()}</p>
        <footer><span>{annotation.authorName}</span><time dateTime={annotation.createdAt}>{new Date(annotation.createdAt).toLocaleString()}</time></footer>
      </section>}
    </div>)}
  </div>
}

export function AppAnnotationList({annotations,onClose,onSelect}:{annotations:AppAnnotation[];onClose:()=>void;onSelect:(annotation:AppAnnotation)=>void}) {
  const visible=annotations.filter(annotation=>!annotation.tableId&&!annotation.rowId)
  return <aside className="hx-annotation-list" aria-label={`注釈${visible.length}件`}>
    <header><strong>注釈{visible.length}件</strong><button type="button" className="hx-app-icon-button" aria-label="注釈一覧を閉じる" onClick={onClose}><Icon name="x" size={16}/></button></header>
    {!visible.length?<p className="hx-annotation-list-empty">このバージョンにはまだ注釈がありません</p>:<div className="hx-annotation-list-items">
      {visible.map(annotation=><button type="button" className="hx-annotation-list-item" key={annotation.id} onClick={()=>onSelect(annotation)}>
        <strong>{annotation.target}</strong><span>{annotation.body.replace(/(?:^|\n{1,2})注釈: [^\n]+\n/,'\n').trim()}</span>
        <small>{annotation.authorName} · {new Date(annotation.createdAt).toLocaleString()}</small>
      </button>)}
    </div>}
  </aside>
}

export function describeAnnotationTarget(target: Element | null | undefined): string {
  if (!target) return '画面上の選択範囲'
  const cell = target.closest('th,td') as HTMLTableCellElement | null
  if (cell && (cell.tagName === 'TH' || cell.tagName === 'TD')) {
    const table = cell.closest('table')
    const column = table?.querySelectorAll('thead th')[cell.cellIndex]?.textContent?.trim()
    if (cell.tagName === 'TH') return column || 'データ表の列'
    const row = cell.closest('tr[data-row]')
    const rows = table ? Array.from(table.querySelectorAll('tbody tr[data-row]')) : []
    const rowNumber = row ? rows.indexOf(row) + 1 : 0
    return column && rowNumber > 0 ? `${column} · ${rowNumber}行目` : column || 'データ表のセル'
  }
  const labelled = target.closest('[aria-label]')?.getAttribute('aria-label')
  if (labelled) return labelled.slice(0, 100)
  const heading = target.closest('h1,h2,h3')?.textContent?.trim()
  if (heading) return `見出し「${heading.slice(0, 80)}」`
  return '画面上の選択範囲'
}

export function annotationTargetAt(x: number, y: number, layer: HTMLElement, root: Pick<Document, 'elementsFromPoint'> = document): string {
  const previousPointerEvents = layer.style.pointerEvents
  layer.style.pointerEvents = 'none'
  let target: Element | undefined
  try {
    target = root.elementsFromPoint(x, y).find(element => element !== layer && !layer.contains(element))
  } finally {
    layer.style.pointerEvents = previousPointerEvents
  }
  return describeAnnotationTarget(target)
}

/**
 * Published custom apps render inside an opaque sandbox frame. Ask the frame's
 * small, host-controlled message bridge to identify the element under the
 * selected point. The frame is accepted only when it is the actual iframe
 * found at that point, and any late/malformed response falls back to the
 * screen coordinates already captured by the caller.
 */
export function resolveCustomAppAnnotationTarget(
  x: number,
  y: number,
  fallback: string,
  root: Pick<Document, 'elementsFromPoint'> = document,
  host?: Pick<Window, 'addEventListener' | 'removeEventListener'>,
): Promise<string> {
  const frame = root.elementsFromPoint(x, y).find(element => element.tagName === 'IFRAME') as HTMLIFrameElement | undefined
  const frameWindow = frame?.contentWindow
  if (!frame || !frameWindow) return Promise.resolve(fallback)
  const eventHost = host ?? (typeof window === 'undefined' ? undefined : window)
  if (!eventHost) return Promise.resolve(fallback)
  const bounds = frame.getBoundingClientRect()
  if (bounds.width <= 0 || bounds.height <= 0) return Promise.resolve(fallback)
  const requestId = crypto.randomUUID()
  return new Promise(resolve => {
    let settled = false
    let timeout: ReturnType<typeof setTimeout>
    const finish = (target: string) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      eventHost.removeEventListener('message', onMessage)
      resolve(target)
    }
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameWindow || event.data?.type !== 'honmaru:annotation-target-result' || event.data.id !== requestId) return
      const target = typeof event.data.target === 'string' ? event.data.target.replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 100) : ''
      finish(target ? `カスタム画面の${target}` : fallback)
    }
    eventHost.addEventListener('message', onMessage)
    timeout = setTimeout(() => finish(fallback), 700)
    try {
      frameWindow.postMessage({
        type: 'honmaru:annotation-target-request',
        id: requestId,
        x: Math.max(0, Math.min(bounds.width, x - bounds.left)),
        y: Math.max(0, Math.min(bounds.height, y - bounds.top)),
      }, '*')
    } catch {
      finish(fallback)
    }
  })
}

export function AppAnnotationLayer({ onSelect, onCancel, onShowAnnotations, showAnnotations }: { onSelect: (selection: AppAnnotationSelection) => void; onCancel: () => void; onShowAnnotations:()=>void; showAnnotations:boolean }) {
  const layer = useRef<HTMLDivElement>(null)
  const start = useRef<{ x: number; y: number } | null>(null)
  const [box, setBox] = useState<{ left: number; top: number; width: number; height: number } | null>(null)
  useEffect(() => { layer.current?.focus() }, [])
  const pointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0 || !layer.current) return
    event.preventDefault()
    const bounds = layer.current.getBoundingClientRect()
    const point = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    start.current = point
    layer.current.setPointerCapture(event.pointerId)
    setBox({ left: point.x, top: point.y, width: 0, height: 0 })
  }
  const pointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current || !layer.current) return
    const bounds = layer.current.getBoundingClientRect()
    const x = event.clientX - bounds.left, y = event.clientY - bounds.top
    setBox({ left: Math.min(start.current.x, x), top: Math.min(start.current.y, y), width: Math.abs(x - start.current.x), height: Math.abs(y - start.current.y) })
  }
  const pointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!start.current || !layer.current) return
    const origin = start.current
    start.current = null
    const bounds = layer.current.getBoundingClientRect()
    const width = Math.abs(event.clientX - bounds.left - origin.x), height = Math.abs(event.clientY - bounds.top - origin.y)
    if (Math.max(width, height) >= 5 && bounds.width > 0 && bounds.height > 0) {
      const clientX = event.clientX, clientY = event.clientY
      const endX=clientX-bounds.left,endY=clientY-bounds.top
      const percent=(value:number,size:number)=>Math.round(value/size*1000)/10
      const selection = {
        target: annotationTargetAt(clientX, clientY, layer.current),
        x: Math.round(((origin.x + clientX - bounds.left) / 2 / bounds.width) * 1000) / 10,
        y: Math.round(((origin.y + clientY - bounds.top) / 2 / bounds.height) * 1000) / 10,
        rect:{left:percent(Math.min(origin.x,endX),bounds.width),top:percent(Math.min(origin.y,endY),bounds.height),width:percent(width,bounds.width),height:percent(height,bounds.height)},
      }
      void resolveCustomAppAnnotationTarget(clientX, clientY, selection.target).then(target => onSelect({ ...selection, target }))
    }
    setBox(null)
  }
  return <div ref={layer} className="hx-annotation-layer" role="application" aria-label="注釈モード。セルをドラッグして注釈。Escapeで終了" tabIndex={0}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { start.current = null; setBox(null) }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onCancel() } }}>
    <div className="hx-annotation-toolbar" role="toolbar" aria-label="注釈操作">
      <span>セルをドラッグして注釈</span>
      <button type="button" aria-label="すべての注釈を表示" aria-pressed={showAnnotations} onPointerDown={event=>event.stopPropagation()} onClick={onShowAnnotations}><Icon name="message" size={14}/></button>
      <button type="button" aria-label="注釈モードを終了" onPointerDown={event=>event.stopPropagation()} onClick={onCancel}><Icon name="x" size={15}/></button>
    </div>
    {box && <span className="hx-annotation-selection" style={box} aria-hidden="true" />}
  </div>
}

export function AppAnnotationDialog({ selection, appName, section, context, onCancel, onSubmit }: {
  selection: AppAnnotationSelection; appName: string; section: string; context?:string; onCancel: () => void; onSubmit: (comment: string) => void
}) {
  const [comment, setComment] = useState('')
  const left=`max(12px, min(${selection.x}%, calc(100% - 324px)))`
  const top=`max(12px, min(calc(${selection.y}% + 30px), calc(100% - 170px)))`
  return <>
    {selection.rect&&<div className="hx-annotation-highlight" aria-hidden="true" style={selection.rect}/>}
    <div className="hx-annotation-popover" style={{left,top}} role="dialog" aria-modal="false" aria-labelledby="hx-annotation-title" tabIndex={-1} onKeyDown={event=>{if(event.key==='Escape'){event.preventDefault();onCancel()}}}>
      <h2 id="hx-annotation-title" className="sr-only">注釈を追加</h2>
      <div className="hx-annotation-context">{context||`${appName} · ${section}`} · {selection.target}</div>
      <form onSubmit={event => { event.preventDefault(); if (comment.trim()) onSubmit(comment.trim()) }}>
        <textarea autoFocus aria-label="どのように修正しますか？" value={comment} maxLength={2000} onChange={event => setComment(event.target.value)} placeholder="どのように修正しますか？" />
        <div className="hx-annotation-actions"><button type="button" className="pill-btn quiet" onClick={onCancel}>キャンセル</button><button type="submit" className="pill-btn" disabled={!comment.trim()}>メッセージに添付</button></div>
      </form>
    </div>
  </>
}
