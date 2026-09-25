import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../utils/i18n'
import type { FileRef } from '../types/card'
import { Icon } from './Icon'
import './Attachments.css'

// Files and pictures: going up from the composer, and shown in a message.
//
// A file goes up the moment it is picked — pasted, dropped, or chosen with
// the paperclip — so that by the time you have written the words it is
// already there, and Send only has to name it. Pictures are shown as they
// are, at their own shape; anything else is a card with its name and size
// that downloads.

export const MAX_FILES = 10
export const MAX_BYTES = 25 * 1024 * 1024

export interface Upload {
  key: string
  name: string
  type: string
  size: number
  /// A picture's own pixels, shown while it goes up.
  preview: string | null
  state: 'up' | 'done' | 'failed'
  file?: FileRef
}

const isPicture = (type: string) => /^image\/(png|jpeg|gif|webp|avif)$/.test(type)

/// A picture's size, so the message keeps its shape before it loads.
async function dimensions(file: File): Promise<{ width: number; height: number } | null> {
  if (!isPicture(file.type)) return null
  try {
    if (typeof createImageBitmap === 'function') {
      const bmp = await createImageBitmap(file)
      const out = { width: bmp.width, height: bmp.height }
      bmp.close?.()
      return out
    }
  } catch { /* fall through */ }
  return null
}

export function sizeLabel(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`
}

/// What is going up for one composer.
export function useUploads(api: { httpBase: string; orgId: string; sessionToken: string }, onProblem: (text: string) => void) {
  const t = useT()
  const [items, setItems] = useState<Upload[]>([])
  const itemsRef = useRef(items)
  itemsRef.current = items
  useEffect(() => () => { for (const i of itemsRef.current) if (i.preview) URL.revokeObjectURL(i.preview) }, [])

  const add = useCallback((files: File[], channel: string) => {
    const room = MAX_FILES - itemsRef.current.length
    if (files.length > room) onProblem(t('Up to {n} files in one message.', { n: MAX_FILES }))
    for (const f of files.slice(0, Math.max(0, room))) {
      if (f.size > MAX_BYTES) { onProblem(t('{name} is larger than 25 MB.', { name: f.name })); continue }
      if (!f.size) continue
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const type = f.type || 'application/octet-stream'
      const up: Upload = { key, name: f.name || 'file', type, size: f.size, preview: isPicture(type) ? URL.createObjectURL(f) : null, state: 'up' }
      setItems((prev) => [...prev, up])
      void (async () => {
        const dim = await dimensions(f)
        const qs = new URLSearchParams({ orgId: api.orgId, channel, name: up.name, ...(dim ? { width: String(dim.width), height: String(dim.height) } : {}) })
        try {
          const res = await fetch(`${api.httpBase}/channels/files?${qs}`, {
            method: 'POST', headers: { 'x-session-token': api.sessionToken, 'content-type': type }, body: f,
          })
          const data = await res.json().catch(() => ({}))
          if (!res.ok) throw new Error(data.message || '')
          setItems((prev) => prev.map((x) => (x.key === key ? { ...x, state: 'done', file: data.file } : x)))
        } catch (e) {
          setItems((prev) => prev.map((x) => (x.key === key ? { ...x, state: 'failed' } : x)))
          onProblem((e as Error).message || t('{name} did not upload. Try again.', { name: up.name }))
        }
      })()
    }
  }, [api.httpBase, api.orgId, api.sessionToken, onProblem, t])

  const remove = useCallback((key: string) => {
    setItems((prev) => {
      const gone = prev.find((x) => x.key === key)
      if (gone?.preview) URL.revokeObjectURL(gone.preview)
      return prev.filter((x) => x.key !== key)
    })
  }, [])
  const clear = useCallback(() => {
    setItems((prev) => { for (const i of prev) if (i.preview) URL.revokeObjectURL(i.preview); return [] })
  }, [])
  const ids = items.filter((i) => i.state === 'done' && i.file).map((i) => i.file!.id)
  const busy = items.some((i) => i.state === 'up')
  return { items, add, remove, clear, ids, busy }
}

/// What is going up, over the words, each with a way to take it back.
export const PendingUploads: React.FC<{ items: Upload[]; onRemove: (key: string) => void }> = ({ items, onRemove }) => {
  const t = useT()
  if (!items.length) return null
  return (
    <div className="att-pending" aria-label={t('Attachments')}>
      {items.map((u) => (
        <div key={u.key} className={`att-pend${u.preview ? ' pic' : ''} ${u.state}`} data-upload={u.state}>
          {u.preview ? <img src={u.preview} alt="" /> : (
            <span className="att-pend-file"><Icon name="file" size={16} /><span><b>{u.name}</b><small>{sizeLabel(u.size)}</small></span></span>
          )}
          {u.state === 'up' && <span className="att-spin" role="status" aria-label={t('Uploading…')} />}
          {u.state === 'failed' && <span className="att-failed" role="alert">!</span>}
          <button type="button" className="att-x" onClick={() => onRemove(u.key)} aria-label={t('Remove {name}', { name: u.name })}><Icon name="x" size={12} /></button>
        </div>
      ))}
    </div>
  )
}

/// A message's files: pictures at their own shape, everything else a card.
export const MessageFiles: React.FC<{ files?: FileRef[]; base: string }> = ({ files, base }) => {
  const t = useT()
  const [open, setOpen] = useState<number | null>(null)
  if (!files?.length) return null
  const pictures = files.filter((f) => isPicture(f.type))
  const others = files.filter((f) => !isPicture(f.type))
  const url = (f: FileRef) => `${base}${f.url}`
  return (
    <div className="att-files">
      {pictures.length > 0 && (
        <div className={`att-pics n${Math.min(pictures.length, 4)}`}>
          {pictures.map((f, i) => {
            const ratio = f.width && f.height ? f.width / f.height : 4 / 3
            return (
              <button key={f.id} type="button" className="att-pic" onClick={() => setOpen(i)} aria-label={t('Open {name}', { name: f.name })}
                style={pictures.length === 1 ? { aspectRatio: String(Math.max(0.5, Math.min(2.4, ratio))), width: `min(100%, ${Math.round(Math.min(360, 280 * Math.max(0.5, Math.min(2.4, ratio))))}px)` } : undefined}>
                <img src={url(f)} alt={f.name} loading="lazy" referrerPolicy="no-referrer" />
              </button>
            )
          })}
        </div>
      )}
      {others.map((f) => (
        <a key={f.id} className="att-file" href={url(f)} target="_blank" rel="noopener noreferrer" data-file={f.name}>
          <span className="att-file-icon" aria-hidden="true"><Icon name="file" size={18} /></span>
          <span className="att-file-text"><b>{f.name}</b><small>{(f.type.split('/')[1] || f.type).toUpperCase().slice(0, 12)} · {sizeLabel(f.size)}</small></span>
          <Icon name="download" size={16} />
        </a>
      ))}
      {open !== null && pictures[open] && (
        <Lightbox
          files={pictures}
          at={open}
          base={base}
          onMove={setOpen}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}

/// One picture at a time, the whole screen, with the others a swipe away.
const Lightbox: React.FC<{ files: FileRef[]; at: number; base: string; onMove: (i: number) => void; onClose: () => void }> = ({ files, at, base, onMove, onClose }) => {
  const t = useT()
  const startX = useRef<number | null>(null)
  const startY = useRef<number | null>(null)
  const f = files[at]
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      else if (e.key === 'ArrowRight' && at < files.length - 1) onMove(at + 1)
      else if (e.key === 'ArrowLeft' && at > 0) onMove(at - 1)
    }
    document.addEventListener('keydown', key)
    return () => document.removeEventListener('keydown', key)
  }, [at, files.length, onClose, onMove])
  return createPortal(
    <div className="att-light" role="dialog" aria-modal="true" aria-label={f.name} onClick={onClose}
      onTouchStart={(e) => { startX.current = e.touches[0]?.clientX ?? null; startY.current = e.touches[0]?.clientY ?? null }}
      onTouchEnd={(e) => {
        const dx = (e.changedTouches[0]?.clientX ?? 0) - (startX.current ?? 0)
        const dy = (e.changedTouches[0]?.clientY ?? 0) - (startY.current ?? 0)
        if (Math.abs(dy) > 90 && Math.abs(dy) > Math.abs(dx)) onClose()
        else if (dx < -60 && at < files.length - 1) onMove(at + 1)
        else if (dx > 60 && at > 0) onMove(at - 1)
      }}>
      <header className="att-light-head" onClick={(e) => e.stopPropagation()}>
        <span>{f.name}{files.length > 1 && <small> · {at + 1} / {files.length}</small>}</span>
        <a href={`${base}${f.url}`} target="_blank" rel="noopener noreferrer" aria-label={t('Download')}><Icon name="download" size={18} /></a>
        <button type="button" onClick={onClose} aria-label={t('Close')}><Icon name="x" size={20} /></button>
      </header>
      <img src={`${base}${f.url}`} alt={f.name} onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body,
  )
}
