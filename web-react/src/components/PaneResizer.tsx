import React, { useEffect, useRef, useState } from 'react'

/// The edge of a pane beside the conversation, dragged to make the pane
/// wider or narrower — a thread pane as wide as its replies want, or as
/// narrow as the conversation needs. The arrow keys move it too (the edge
/// is a separator, so ← widens the pane and → narrows it), Home and End go
/// to the widest and narrowest it can be, and a double click or Enter puts
/// it back to the width the layout gives it.
///
/// While dragging, only the pane's own width changes; the width is handed
/// back when the drag ends, so a long conversation is not redrawn on every
/// movement of the pointer.

/// Narrower than this, a reply's tools and the box under it do not fit.
export const PANE_MIN = 320
/// What the conversation keeps beside a pane that sits next to it.
export const CONVERSATION_MIN = 360
const STEP = 24
const BIG_STEP = 96

/// A width the pane can take, given the most there is room for.
export function clampWidth(width: number, max: number): number {
  return Math.round(Math.max(PANE_MIN, Math.min(width, Math.max(PANE_MIN, max))))
}

/// What a key on the edge does to the width, or null when it does nothing.
export function keyWidth(key: string, width: number, max: number, shift = false): number | null {
  const step = shift ? BIG_STEP : STEP
  switch (key) {
    case 'ArrowLeft': return clampWidth(width + step, max)
    case 'ArrowRight': return clampWidth(width - step, max)
    case 'PageUp': return clampWidth(width + BIG_STEP, max)
    case 'PageDown': return clampWidth(width - BIG_STEP, max)
    case 'Home': return clampWidth(max, max)
    case 'End': return PANE_MIN
    default: return null
  }
}

/// How wide the pane could be: over the conversation, almost the window;
/// beside it, as much as leaves the conversation its room.
export function roomFor(pane: HTMLElement): number {
  const r = pane.getBoundingClientRect()
  if (getComputedStyle(pane).position === 'fixed') return r.right - 80
  const main = pane.parentElement?.querySelector<HTMLElement>(':scope > .slk-main')
  const left = main ? main.getBoundingClientRect().left : 0
  return r.right - left - CONVERSATION_MIN
}

export function PaneResizer({ pane, label, title, onWidth, onReset }: {
  pane: React.RefObject<HTMLElement>
  label: string
  /// What the pointer is told on hover.
  title?: string
  /// A width chosen: at the end of a drag, or by a key.
  onWidth: (width: number) => void
  /// Back to the layout's own width.
  onReset: () => void
}) {
  // The pane's width as it is, for a screen reader; measured, so it is
  // right whether the layout or the reader chose it.
  const [shown, setShown] = useState<number | null>(null)
  const [max, setMax] = useState<number>(PANE_MIN)
  const drag = useRef<{ x: number; width: number; max: number; id: number } | null>(null)
  useEffect(() => {
    const el = pane.current
    if (!el) return
    const measure = () => { setShown(Math.round(el.getBoundingClientRect().width)); setMax(Math.round(roomFor(el))) }
    measure()
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null
    ro?.observe(el)
    window.addEventListener('resize', measure)
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure) }
  }, [pane])

  const end = (commit: boolean) => {
    const el = pane.current
    const d = drag.current
    drag.current = null
    document.body.classList.remove('slk-resizing')
    if (!el || !d || !commit) return
    onWidth(Math.round(el.getBoundingClientRect().width))
  }

  return (
    <div
      className="slk-pane-resize"
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      title={title}
      aria-valuemin={PANE_MIN}
      aria-valuemax={Math.max(PANE_MIN, max)}
      aria-valuenow={shown ?? undefined}
      tabIndex={0}
      data-pane-resize="1"
      onPointerDown={(e) => {
        const el = pane.current
        if (!el || e.button !== 0) return
        e.preventDefault()
        e.currentTarget.setPointerCapture(e.pointerId)
        drag.current = { x: e.clientX, width: el.getBoundingClientRect().width, max: roomFor(el), id: e.pointerId }
        document.body.classList.add('slk-resizing')
      }}
      onPointerMove={(e) => {
        const el = pane.current
        const d = drag.current
        if (!el || !d || d.id !== e.pointerId) return
        // The edge is on the pane's left: moving it left widens the pane.
        el.style.width = `${clampWidth(d.width + (d.x - e.clientX), d.max)}px`
      }}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(true)}
      onLostPointerCapture={() => { if (drag.current) end(true) }}
      onDoubleClick={() => { if (pane.current) pane.current.style.width = ''; onReset() }}
      onKeyDown={(e) => {
        const el = pane.current
        if (!el) return
        if (e.key === 'Enter') { e.preventDefault(); el.style.width = ''; onReset(); return }
        const next = keyWidth(e.key, el.getBoundingClientRect().width, roomFor(el), e.shiftKey)
        if (next === null) return
        e.preventDefault()
        el.style.width = `${next}px`
        onWidth(next)
      }}
    />
  )
}
