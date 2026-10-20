import React, { useRef, useState } from 'react'
import { Dialog } from './Dialog'
import { useT } from '../utils/i18n'
import type { AgentLook } from './AgentAvatar'
import './AgentAvatarPreview.css'

export function AgentAvatarPreview({ agent, onClose }: { agent: AgentLook & { name: string }; onClose: () => void }) {
  const t = useT()
  const [zoom, setZoom] = useState(1), [offset, setOffset] = useState({ x: 0, y: 0 })
  const [failed, setFailed] = useState(false)
  const drag = useRef<{ id: number; x: number; y: number; startX: number; startY: number } | null>(null)
  const viewport = useRef<HTMLDivElement>(null)
  const title = t('{name}’s avatar', { name: agent.name })
  const clamp = (x: number, y: number, scale = zoom) => {
    const rect = viewport.current?.getBoundingClientRect()
    const maxX = (rect?.width || 0) * Math.max(0, scale - 1) / 2
    const maxY = (rect?.height || 0) * Math.max(0, scale - 1) / 2
    return { x: Math.max(-maxX, Math.min(maxX, x)), y: Math.max(-maxY, Math.min(maxY, y)) }
  }
  const changeZoom = (value: number) => {
    const next = Math.max(.5, Math.min(4, Math.round(value * 100) / 100))
    setZoom(next); setOffset(current => clamp(current.x, current.y, next))
  }
  return <Dialog title={title} className="hx-avatar-preview" onClose={onClose}>
    <div ref={viewport} className="hx-avatar-viewport" role="region" aria-label={t('Zoomable image preview')} tabIndex={0}
      style={{ cursor: zoom > 1 ? 'grab' : 'default' }}
      onKeyDown={event => {
        if (event.key === '+' || event.key === '=') { event.preventDefault(); changeZoom(zoom + .25) }
        if (event.key === '-') { event.preventDefault(); changeZoom(zoom - .25) }
        if (event.key === '0') { event.preventDefault(); setZoom(1); setOffset({ x: 0, y: 0 }) }
      }}
      onPointerDown={event => {
        if (zoom <= 1 || event.button !== 0) return
        event.currentTarget.setPointerCapture(event.pointerId)
        drag.current = { id: event.pointerId, x: event.clientX, y: event.clientY, startX: offset.x, startY: offset.y }
      }}
      onPointerMove={event => {
        const start = drag.current
        if (start?.id === event.pointerId) setOffset(clamp(start.startX + event.clientX - start.x, start.startY + event.clientY - start.y))
      }}
      onPointerUp={() => { drag.current = null }} onPointerCancel={() => { drag.current = null }} onLostPointerCapture={() => { drag.current = null }}>
      <div className="hx-avatar-preview-image" style={{ transform: `translate(${offset.x}px, ${offset.y}px) scale(${zoom})` }}>
        {agent.avatarUrl && !failed ? <img src={agent.avatarUrl} alt={title} draggable={false} onError={() => setFailed(true)}/> : <span role="img" aria-label={title}>{agent.emoji || '🤖'}</span>}
      </div>
    </div>
    {failed && <p className="hx-avatar-load-error" role="status">{t('The picture could not be loaded.')}</p>}
    <div className="hx-avatar-zoom" role="group" aria-label={t('Zoom')}>
      <button disabled={zoom <= .5} onClick={() => changeZoom(zoom - .25)} aria-label={t('Zoom out')}>−</button>
      <button onClick={() => { setZoom(1); setOffset({ x: 0, y: 0 }) }} aria-label={t('Reset zoom')}>{Math.round(zoom * 100)}%</button>
      <button disabled={zoom >= 4} onClick={() => changeZoom(zoom + .25)} aria-label={t('Zoom in')}>+</button>
    </div>
  </Dialog>
}
