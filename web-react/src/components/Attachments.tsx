import React, {lazy,Suspense, useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../utils/i18n'
import type { FileRef } from '../types/card'
import { mediaKind, videoBox, downloadUrl, firstFrameUrl, type MediaKind } from '../utils/media'
import { Icon, type IconName } from './Icon'
import './Attachments.css'
import { composing } from '../utils/keys'
import {documentKind} from '../utils/documentPreview'
const DocumentPreview=lazy(()=>import('./DocumentPreview'))
import { fileSrc, useFileUrls } from '../utils/mediaUrls'

// Files and pictures: going up from the composer, and shown in a message.
//
// A file goes up the moment it is picked — pasted, dropped, or chosen with
// the paperclip — so that by the time you have written the words it is
// already there, and Send only has to name it. Pictures are shown as they
// are, at their own shape; a video or a song plays where it is; anything
// else is a card with its name and size that downloads.

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

/// Each kind's mark, on a file's card and beside a player's name.
const KIND_ICON: Record<MediaKind, IconName> = { image: 'image', video: 'video', audio: 'headphones', file: 'file' }

type Size = { width: number; height: number }

/// A picture's or a video's size, so the message keeps its shape before it
/// loads.
async function dimensions(file: File): Promise<Size | null> {
  const kind = mediaKind(file.type, file.name)
  // The upload waits on this, so a video that cannot be measured goes up
  // without a size rather than never going up at all.
  if (kind === 'video') return videoDimensions(file).catch(() => null)
  if (kind !== 'image') return null
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

/// The long side a photo is sent at, and the size a photo has to pass
/// before it is redrawn: a phone's photos run to several megabytes, which
/// is what made them slow to go up. Anything smaller goes as it is.
export const PHOTO_MAX_PIXELS = 2560
const PHOTO_SHRINK_BYTES = 1_500_000
/// Kinds redrawn as a JPEG: photographs. A PNG may be see-through or a
/// screenshot whose text should stay sharp, and a GIF may move, so those go
/// as they are.
const SHRINKABLE = new Set(['image/jpeg', 'image/jpg', 'image/webp', 'image/heic', 'image/heif'])

/// The size to redraw a picked picture at before it goes up, or null to
/// send it as it is.
export function shrinkPlan(type: string, bytes: number, size: Size): Size | null {
  if (!SHRINKABLE.has(type.toLowerCase())) return null
  const long = Math.max(size.width, size.height)
  if (!(long > 0) || (long <= PHOTO_MAX_PIXELS && bytes <= PHOTO_SHRINK_BYTES)) return null
  const scale = Math.min(1, PHOTO_MAX_PIXELS / long)
  return { width: Math.max(1, Math.round(size.width * scale)), height: Math.max(1, Math.round(size.height * scale)) }
}

/// What goes up for a picked file: a large photo redrawn at its plan as a
/// JPEG, anything else — or anything the browser cannot redraw, or that
/// would come out no smaller — as it is.
async function readyToSend(file: File): Promise<{ body: Blob; type: string; name: string; size: Size | null }> {
  const size = await dimensions(file)
  const original = { body: file as Blob, type: file.type || 'application/octet-stream', name: file.name || 'file', size }
  const plan = size ? shrinkPlan(file.type, file.size, size) : null
  if (!plan || typeof document === 'undefined' || typeof createImageBitmap !== 'function') return original
  try {
    const bmp = await createImageBitmap(file, { imageOrientation: 'from-image', resizeWidth: plan.width, resizeHeight: plan.height, resizeQuality: 'high' })
    const canvas = document.createElement('canvas')
    canvas.width = plan.width
    canvas.height = plan.height
    canvas.getContext('2d')?.drawImage(bmp, 0, 0, plan.width, plan.height)
    bmp.close?.()
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
    if (!blob || blob.size >= file.size) return original
    return { body: blob, type: 'image/jpeg', name: `${(file.name || 'photo').replace(/\.[^.]+$/, '')}.jpg`, size: plan }
  } catch {
    return original
  }
}

/// A video's size, from its header: the browser reads only as far as that,
/// and the upload does not wait more than a few seconds for it.
function videoDimensions(file: File): Promise<Size | null> {
  if (typeof document === 'undefined') return Promise.resolve(null)
  return new Promise((resolve) => {
    const v = document.createElement('video')
    const src = URL.createObjectURL(file)
    const done = (size: Size | null) => {
      clearTimeout(timer)
      v.onloadedmetadata = null
      v.onerror = null
      v.removeAttribute('src')
      v.load()
      URL.revokeObjectURL(src)
      resolve(size)
    }
    const timer = setTimeout(() => done(null), 3000)
    v.muted = true
    v.preload = 'metadata'
    v.onloadedmetadata = () => done(v.videoWidth && v.videoHeight ? { width: v.videoWidth, height: v.videoHeight } : null)
    v.onerror = () => done(null)
    v.src = src
  })
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
      // A photo over the limit may still go once it is redrawn smaller.
      if (f.size > MAX_BYTES && !SHRINKABLE.has((f.type || '').toLowerCase())) { onProblem(t('{name} is larger than 25 MB.', { name: f.name })); continue }
      if (!f.size) continue
      const key = `${Date.now()}-${Math.random().toString(36).slice(2)}`
      const type = f.type || 'application/octet-stream'
      const up: Upload = { key, name: f.name || 'file', type, size: f.size, preview: mediaKind(type, f.name) === 'image' ? URL.createObjectURL(f) : null, state: 'up' }
      setItems((prev) => [...prev, up])
      void (async () => {
        try {
          const ready = await readyToSend(f)
          if (ready.body.size > MAX_BYTES) throw new Error(t('{name} is larger than 25 MB.', { name: up.name }))
          const dim = ready.size
          const qs = new URLSearchParams({ orgId: api.orgId, channel, name: ready.name, ...(dim ? { width: String(dim.width), height: String(dim.height) } : {}) })
          const res = await fetch(`${api.httpBase}/channels/files?${qs}`, {
            method: 'POST', headers: { 'x-session-token': api.sessionToken, 'content-type': ready.type }, body: ready.body,
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

  /// Files already up, back in the box: a message that did not go, being
  /// written again. Nothing to upload — they are named as they are — and,
  /// as for any file added, no more than a message can carry.
  const restore = useCallback((files: FileRef[]) => {
    const room = MAX_FILES - itemsRef.current.length
    if (files.length > room) onProblem(t('Up to {n} files in one message.', { n: MAX_FILES }))
    const back = files.slice(0, Math.max(0, room)).map((f): Upload => ({
      key: `${Date.now()}-${Math.random().toString(36).slice(2)}`, name: f.name, type: f.type, size: f.size,
      preview: mediaKind(f.type, f.name) === 'image' ? fileSrc(api.httpBase, f.url) : null, state: 'done', file: f,
    }))
    if (back.length) setItems((prev) => [...prev, ...back])
  }, [api.httpBase, onProblem, t])

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
  return { items, add, restore, remove, clear, ids, busy }
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
            <span className="att-pend-file"><Icon name={KIND_ICON[mediaKind(u.type, u.name)]} size={16} /><span><b>{u.name}</b><small>{sizeLabel(u.size)}</small></span></span>
          )}
          {u.state === 'up' && <span className="att-spin" role="status" aria-label={t('Uploading…')} />}
          {u.state === 'failed' && <span className="att-failed" role="alert">!</span>}
          <button type="button" className="att-x" onClick={() => onRemove(u.key)} aria-label={t('Remove {name}', { name: u.name })}><Icon name="x" size={12} /></button>
        </div>
      ))}
    </div>
  )
}

/// A message's files: pictures at their own shape, videos and songs played
/// where they are, everything else a card.
export const MessageFiles: React.FC<{ files?: FileRef[]; base: string }> = ({ files, base }) => {
  const t = useT()
  const [open, setOpen] = useState<number | null>(null)
  // Kept by id; each address renewed before it runs out.
  const addr = useFileUrls(base, files)
  if (!files?.length) return null
  const pictures = files.filter((f) => mediaKind(f.type, f.name) === 'image')
  const others = files.filter((f) => mediaKind(f.type, f.name) !== 'image')
  const url = addr.src
  return (
    <div className="att-files">
      {pictures.length > 0 && (
        <div className={`att-pics n${Math.min(pictures.length, 4)}`}>
          {pictures.map((f, i) => {
            const ratio = f.width && f.height ? f.width / f.height : 4 / 3
            return (
              <button key={f.id} type="button" className="att-pic" onClick={() => setOpen(i)} aria-label={t('Open {name}', { name: f.name })}
                style={pictures.length === 1 ? { aspectRatio: String(Math.max(0.5, Math.min(2.4, ratio))), width: `min(100%, ${Math.round(Math.min(360, 280 * Math.max(0.5, Math.min(2.4, ratio))))}px)` } : undefined}>
                <img src={url(f)} alt={f.name} loading="lazy" referrerPolicy="no-referrer" onError={() => addr.stale(f)} />
              </button>
            )
          })}
        </div>
      )}
      {others.map((f) => {
        const kind = mediaKind(f.type, f.name)
        return kind === 'video' || kind === 'audio'
          ? <Player key={f.id} file={f} kind={kind} src={url(f)} onStale={() => addr.stale(f)} />
          : <FileCard key={f.id} file={f} href={url(f)} />
      })}
      {open !== null && pictures[open] && (
        <Lightbox
          files={pictures}
          at={open}
          src={url}
          onMove={setOpen}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  )
}

/// A file that is not shown: its name, kind and size, and a way to save it.
const FileCard: React.FC<{ file: FileRef; href: string }> = ({ file, href }) => {
  const [open,setOpen]=useState(false)
  const kind=documentKind(file.type,file.name)
  const content=<><span className="att-file-icon" aria-hidden="true"><Icon name={KIND_ICON[mediaKind(file.type,file.name)]} size={18}/></span><span className="att-file-text"><b>{file.name}</b><small>{(file.type.split('/')[1]||file.type).toUpperCase().slice(0,12)} · {sizeLabel(file.size)}</small></span><Icon name={kind?'external':'download'} size={16}/></>
  if(!kind)return <a className="att-file" href={href} target="_blank" rel="noopener noreferrer" data-file={file.name}>{content}</a>
  return <><div className="att-document"><button type="button" className="att-file" data-file={file.name} aria-label={`${file.name}をプレビュー`} onClick={()=>setOpen(true)}>{content}</button><a className="att-document-download" href={downloadUrl(href)} target="_blank" rel="noopener noreferrer" aria-label={`${file.name}をダウンロード`}><Icon name="download" size={16}/></a></div>
    {open&&<DocumentPreviewBoundary onClose={()=>setOpen(false)}><Suspense fallback={<p role="status">プレビューを準備しています…</p>}><DocumentPreview file={file} href={href} onClose={()=>setOpen(false)}/></Suspense></DocumentPreviewBoundary>}
  </>
}

class DocumentPreviewBoundary extends React.Component<React.PropsWithChildren<{onClose:()=>void}>,{failed:boolean}>{
  state={failed:false}
  static getDerivedStateFromError(){return {failed:true}}
  render(){return this.state.failed?<p role="alert">プレビューを起動できませんでした。ファイルはダウンロードして確認できます。<button type="button" onClick={this.props.onClose}>閉じる</button></p>:this.props.children}
}

/// Reference lists keep their compact link layout and use the same reader.
/// Modified clicks retain the browser's ordinary open/download behavior.
export function FileReferenceLink({file,href,className,children}:{file:FileRef;href:string;className?:string;children:React.ReactNode}){
  const [open,setOpen]=useState(false)
  return <><a href={href} className={className} target="_blank" rel="noopener noreferrer" onClick={event=>{
    if(documentKind(file.type,file.name)&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey&&event.button===0){event.preventDefault();setOpen(true)}
  }}>{children}</a>
   {open&&<DocumentPreviewBoundary onClose={()=>setOpen(false)}><Suspense fallback={<p role="status">プレビューを準備しています…</p>}><DocumentPreview file={file} href={href} onClose={()=>setOpen(false)}/></Suspense></DocumentPreviewBoundary>}
  </>
}

/// What a player says went wrong, as the browser numbers it (MediaError):
/// the connection went while it was playing, the bytes would not decode, or
/// nothing at the address is a thing this browser plays.
const DROPPED = 2
const UNREADABLE = 3
const UNPLAYABLE = 4

/// A video or a song, played where it is with the browser's own controls,
/// and under it its name and a way to save it. A video is drawn at the
/// shape it was measured at, so the list does not move when it loads, and
/// asked for its first frame, which an iPhone does not draw unasked; a
/// song loads nothing until it is played. One this browser cannot play
/// becomes the card that saves it.
///
/// It plays from the address it was first given. A file's signed address
/// is a new one each day, and the message read again brings it; handed to
/// the player, that would stop what is playing and take it back to the
/// start, though the old address is good for a day yet. The new one is
/// taken up only when the old one fails.
///
/// A connection that drops is not a file that cannot be played. The player
/// stays, as one that loads nothing until it is played again (asked for at
/// once, with no connection, the browser would call the file unplayable),
/// and then goes on from where it had got to.
const Player: React.FC<{ file: FileRef; kind: 'video' | 'audio'; src: string; onStale?: () => void }> = ({ file, kind, src, onStale }) => {
  const t = useT()
  const [broken, setBroken] = useState(false)
  const [from, setFrom] = useState(src)
  /// How many times the connection has gone from under it.
  const [drops, setDrops] = useState(0)
  /// Where it had got to when it stopped, in seconds.
  const reached = useRef(0)
  /// Its address ran out under it: a new one is on its way, and it goes on
  /// from there when it comes.
  const waiting = useRef(false)
  useEffect(() => {
    if (!waiting.current || src === from) return
    waiting.current = false
    setFrom(src)
    setDrops((d) => d + 1)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src])
  const failed = (e: React.SyntheticEvent<HTMLMediaElement>) => {
    const code = e.currentTarget.error?.code
    if (e.currentTarget.currentTime > 0) reached.current = e.currentTarget.currentTime
    // A browser says a connection dropped only of what it had begun to
    // play, so after one, "unplayable" means the address was not reached.
    if (code === DROPPED || (code === UNPLAYABLE && drops > 0)) { setFrom(src); setDrops(drops + 1) }
    else if (src !== from) setFrom(src)
    else if (onStale && file.expiresAt && file.expiresAt - 60_000 <= Date.now() && !waiting.current) { waiting.current = true; onStale() }
    else if (code === UNREADABLE || code === UNPLAYABLE) setBroken(true)
  }
  const resume = (e: React.SyntheticEvent<HTMLMediaElement>) => {
    if (reached.current > 0) e.currentTarget.currentTime = reached.current
    reached.current = 0
  }
  if (broken) return <FileCard file={file} href={downloadUrl(src)} />
  const about = (
    <figcaption className="att-media-about">
      <Icon name={KIND_ICON[kind]} size={14} />
      <span className="att-media-name">{file.name}</span>
      <small>{sizeLabel(file.size)}</small>
      <a className="att-media-save" href={downloadUrl(src)} target="_blank" rel="noopener noreferrer" aria-label={t('Download {name}', { name: file.name })} title={t('Download')}>
        <Icon name="download" size={16} />
      </a>
    </figcaption>
  )
  if (kind === 'video') {
    const box = videoBox(file.width, file.height)
    return (
      <figure className="att-media video" style={{ width: `min(100%, ${box.width}px)` }} data-file={file.name}>
        <video key={drops} src={firstFrameUrl(from)} controls preload={drops ? 'none' : 'metadata'} playsInline aria-label={file.name} style={{ aspectRatio: String(box.ratio) }} onError={failed} onLoadedMetadata={resume} />
        {about}
      </figure>
    )
  }
  return (
    <figure className="att-media audio" data-file={file.name}>
      {about}
      <audio key={drops} src={from} controls preload="none" aria-label={file.name} onError={failed} onLoadedMetadata={resume} />
    </figure>
  )
}

/// One picture at a time, the whole screen, with the others a swipe away.
const Lightbox: React.FC<{ files: FileRef[]; at: number; src: (f: FileRef) => string; onMove: (i: number) => void; onClose: () => void }> = ({ files, at, src, onMove, onClose }) => {
  const t = useT()
  const startX = useRef<number | null>(null)
  const startY = useRef<number | null>(null)
  const f = files[at]
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !composing(e)) onClose()
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
        <a href={src(f)} target="_blank" rel="noopener noreferrer" aria-label={t('Download')}><Icon name="download" size={18} /></a>
        <button type="button" onClick={onClose} aria-label={t('Close')}><Icon name="x" size={20} /></button>
      </header>
      <img src={src(f)} alt={f.name} onClick={(e) => e.stopPropagation()} />
    </div>,
    document.body,
  )
}
