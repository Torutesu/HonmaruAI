import React, { useEffect, useRef, useState } from 'react'

export type AppAnnotationSelection = { target: string; x: number; y: number }

export function describeAnnotationTarget(target: Element | null | undefined): string {
  if (!target) return '画面上の選択範囲'
  const cell = target.closest('th,td') as HTMLTableCellElement | null
  if (cell && (cell.tagName === 'TH' || cell.tagName === 'TD')) {
    const table = cell.closest('table')
    const column = table?.querySelectorAll('thead th')[cell.cellIndex]?.textContent?.trim()
    if (cell.tagName === 'TH') return column ? `列「${column}」` : 'データ表の列'
    const row = cell.closest('tr[data-row]')
    const rows = table ? Array.from(table.querySelectorAll('tbody tr[data-row]')) : []
    const rowNumber = row ? rows.indexOf(row) + 1 : 0
    return column && rowNumber > 0 ? `「${column}」列の${rowNumber}行目` : column ? `「${column}」列のセル` : 'データ表のセル'
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

export function AppAnnotationLayer({ onSelect, onCancel }: { onSelect: (selection: AppAnnotationSelection) => void; onCancel: () => void }) {
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
      onSelect({
        target: annotationTargetAt(event.clientX, event.clientY, layer.current),
        x: Math.round(((origin.x + event.clientX - bounds.left) / 2 / bounds.width) * 1000) / 10,
        y: Math.round(((origin.y + event.clientY - bounds.top) / 2 / bounds.height) * 1000) / 10,
      })
    }
    setBox(null)
  }
  return <div ref={layer} className="hx-annotation-layer" role="application" aria-label="注釈モード。セルをドラッグして注釈。Escapeで終了" tabIndex={0}
    onPointerDown={pointerDown} onPointerMove={pointerMove} onPointerUp={pointerUp} onPointerCancel={() => { start.current = null; setBox(null) }}
    onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); onCancel() } }}>
    <div className="hx-annotation-instruction" role="status">セルをドラッグして注釈 <span>Escapeで終了</span></div>
    {box && <span className="hx-annotation-selection" style={box} aria-hidden="true" />}
  </div>
}

export function AppAnnotationDialog({ selection, appName, section, onCancel, onSubmit }: {
  selection: AppAnnotationSelection; appName: string; section: string; onCancel: () => void; onSubmit: (comment: string) => void
}) {
  const [comment, setComment] = useState('')
  return <div className="hx-annotation-scrim" onMouseDown={event => { if (event.target === event.currentTarget) onCancel() }}>
    <form className="hx-annotation-dialog" role="dialog" aria-modal="true" aria-labelledby="hx-annotation-title" onSubmit={event => { event.preventDefault(); if (comment.trim()) onSubmit(comment.trim()) }}>
      <h2 id="hx-annotation-title">注釈を追加</h2>
      <p>{appName} · {section} · {selection.target} · 画面位置 {selection.x}% / {selection.y}%</p>
      <label>修正したい内容<textarea autoFocus value={comment} maxLength={2000} onChange={event => setComment(event.target.value)} placeholder="この部分をどう変更するか書いてください" /></label>
      <div className="hx-annotation-actions"><button type="button" className="pill-btn quiet" onClick={onCancel}>キャンセル</button><button type="submit" className="pill-btn" disabled={!comment.trim()}>会話の下書きに追加</button></div>
      <small>コメントはアプリ会話に下書きされます。送信前に編集できます。</small>
    </form>
  </div>
}
