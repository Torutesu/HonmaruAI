import React, { useEffect, useRef } from 'react'
import { createPortal } from 'react-dom'
import { useT } from '../utils/i18n'
import type { ChannelMessage } from '../types/card'
import { Icon, type IconName } from './Icon'
import { EmojiPicker } from './MessageParts'
import { Avatar } from './Avatar'
import './Sheet.css'

// A sheet that comes up from the bottom of a phone: what a long press on a
// message opens, and the "new message" choices. A phone has no hover, so
// the bar of tools a laptop shows over a message has nowhere to be; this is
// where they go, as every phone chat app puts them.

/// The frame: a scrim, a handle, the rows. Escape, the scrim and a swipe
/// down close it.
export const Sheet: React.FC<{ label: string; onClose: () => void; children: React.ReactNode; className?: string }> = ({ label, onClose, children, className }) => {
  const box = useRef<HTMLDivElement>(null)
  const startY = useRef<number | null>(null)
  useEffect(() => {
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', key)
    // The first control, so a keyboard or a screen reader lands in it.
    requestAnimationFrame(() => box.current?.querySelector<HTMLElement>('button, input')?.focus({ preventScroll: true }))
    return () => document.removeEventListener('keydown', key)
  }, [onClose])
  return createPortal(
    <div className="msheet-scrim" onClick={onClose}>
      <div
        ref={box}
        className={`msheet${className ? ` ${className}` : ''}`}
        role="dialog"
        aria-modal="true"
        aria-label={label}
        onClick={(e) => e.stopPropagation()}
        onTouchStart={(e) => { startY.current = e.touches[0]?.clientY ?? null }}
        onTouchEnd={(e) => {
          const from = startY.current
          startY.current = null
          const to = e.changedTouches[0]?.clientY
          if (from !== null && to !== undefined && to - from > 70 && (box.current?.scrollTop || 0) <= 0) onClose()
        }}
      >
        <span className="msheet-handle" aria-hidden="true" />
        {children}
      </div>
    </div>,
    document.body,
  )
}

export const SheetRow: React.FC<{ icon: IconName; label: string; onClick: () => void; danger?: boolean; hint?: string; data?: string }> = ({ icon, label, onClick, danger, hint, data }) => (
  <button type="button" className={`msheet-row${danger ? ' danger' : ''}`} onClick={onClick} data-sheet={data}>
    <Icon name={icon} size={19} />
    <span>{label}</span>
    {hint && <small>{hint}</small>}
  </button>
)

/// What a long press on a message offers: a row of reactions, then what
/// you can do to it. Everything a laptop has on hover and behind ⋯.
export const MessageSheet: React.FC<{
  message: ChannelMessage
  inThread?: boolean
  onClose: () => void
  onReact: (emoji: string) => void
  onReply?: () => void
  onPin?: () => void
  onEdit?: () => void
  onDelete?: () => void
  onDecide?: () => void
  onLater?: (remindAt: string | null) => void
  onCopyLink?: () => void
}> = ({ message, inThread, onClose, onReact, onReply, onPin, onEdit, onDelete, onDecide, onLater, onCopyLink }) => {
  const t = useT()
  const [picker, setPicker] = React.useState(false)
  const run = (fn?: () => void) => () => { onClose(); fn?.() }
  const QUICK = ['👍', '✅', '👀', '🙌', '🎉', '🙏']
  return (
    <Sheet label={t('Message actions')} onClose={onClose}>
      <div className="msheet-reactions" role="group" aria-label={t('Add reaction')}>
        {QUICK.map((e) => (
          <button key={e} type="button" onClick={() => { onReact(e); onClose() }} aria-label={t('React with {emoji}', { emoji: e })}>{e}</button>
        ))}
        <button type="button" className="more" onClick={() => setPicker((p) => !p)} aria-label={t('Add reaction')} aria-expanded={picker}><Icon name="smile" size={20} /></button>
      </div>
      {picker && <div className="msheet-picker"><EmojiPicker onPick={(e) => { onReact(e); onClose() }} onClose={() => setPicker(false)} /></div>}
      <div className="msheet-rows">
        {onReply && !inThread && <SheetRow icon="message" label={t('Reply in thread')} onClick={run(onReply)} data="reply" />}
        {message.body && <SheetRow icon="copy" label={t('Copy text')} onClick={run(() => { void navigator.clipboard?.writeText(message.body) })} data="copy" />}
        {onCopyLink && <SheetRow icon="link" label={t('Copy link')} onClick={run(onCopyLink)} data="link" />}
        {onLater && <SheetRow icon="bookmark" label={t('Save for later')} onClick={run(() => onLater(null))} data="later" />}
        {onLater && <SheetRow icon="clock" label={t('Remind me in 1 hour')} onClick={run(() => onLater(new Date(Date.now() + 3600000).toISOString()))} />}
        {onPin && !inThread && <SheetRow icon="pin" label={message.pinned ? t('Unpin') : t('Pin to channel')} onClick={run(onPin)} data="pin" />}
        {onDecide && <SheetRow icon="sparkle" label={t('Make it a decision')} onClick={run(onDecide)} data="decide" />}
        {onEdit && <SheetRow icon="edit" label={t('Edit message')} onClick={run(onEdit)} data="edit" />}
        {onDelete && <SheetRow icon="trash" label={t('Delete message')} onClick={run(onDelete)} danger data="delete" />}
      </div>
    </Sheet>
  )
}

/// A press held on a touch screen: `fn` after half a second, unless the
/// finger moved (that was a scroll) or lifted first (that was a tap).
export function longPress(fn: (() => void) | undefined): React.HTMLAttributes<HTMLElement> {
  if (!fn) return {}
  let timer: ReturnType<typeof setTimeout> | null = null
  let x = 0
  let y = 0
  const stop = () => { if (timer) clearTimeout(timer); timer = null }
  return {
    onTouchStart: (e) => {
      const target = e.target as HTMLElement
      // Not over something that is its own control.
      if (target.closest('button, a, input, textarea, [contenteditable="true"]')) return
      x = e.touches[0]?.clientX ?? 0
      y = e.touches[0]?.clientY ?? 0
      stop()
      timer = setTimeout(() => { timer = null; try { navigator.vibrate?.(10) } catch { /* no buzz */ } fn() }, 480)
    },
    onTouchMove: (e) => {
      const t = e.touches[0]
      if (t && (Math.abs(t.clientX - x) > 10 || Math.abs(t.clientY - y) > 10)) stop()
    },
    onTouchEnd: stop,
    onTouchCancel: stop,
    // Android's long press, and a right click where there is no hover.
    onContextMenu: (e) => {
      const target = e.target as HTMLElement
      if (target.closest('a, input, textarea')) return
      e.preventDefault()
      stop()
      fn()
    },
  }
}

/// "New message": pick one person for a DM, or several for a group.
export const PeoplePicker: React.FC<{
  members: Array<{ ref: string; name: string; avatarUrl?: string | null; title?: string }>
  onClose: () => void
  onStart: (refs: string[]) => void
  /// How many others a conversation may hold; one when groups are not wanted.
  max?: number
}> = ({ members, onClose, onStart, max = 8 }) => {
  const t = useT()
  const [q, setQ] = React.useState('')
  const [picked, setPicked] = React.useState<string[]>([])
  const needle = q.trim().toLowerCase()
  const shown = members.filter((m) => !needle || m.name.toLowerCase().includes(needle) || (m.title || '').toLowerCase().includes(needle))
  const toggle = (ref: string) => setPicked((p) => (p.includes(ref) ? p.filter((x) => x !== ref) : p.length >= max ? p : [...p, ref]))
  const nameOf = (ref: string) => members.find((m) => m.ref === ref)?.name || ''
  return (
    <Sheet label={t('New message')} onClose={onClose} className="people">
      <p className="msheet-title">{t('New message')}</p>
      <label className="msheet-search">
        <Icon name="search" size={16} />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('Find somebody')} aria-label={t('Find somebody')} />
      </label>
      {picked.length > 0 && (
        <div className="msheet-chips">
          {picked.map((ref) => (
            <button key={ref} type="button" className="msheet-chip" onClick={() => toggle(ref)} aria-label={t('Remove {name}', { name: nameOf(ref) })}>
              <Avatar name={nameOf(ref)} url={members.find((m) => m.ref === ref)?.avatarUrl} size={22} round />{nameOf(ref)}<Icon name="x" size={12} />
            </button>
          ))}
        </div>
      )}
      <div role="listbox" aria-multiselectable={max > 1} aria-label={t('People')}>
        {shown.length === 0 && <p className="msheet-empty">{t('Nobody by that name.')}</p>}
        {shown.map((m) => (
          <button key={m.ref} type="button" role="option" className="msheet-person" aria-checked={picked.includes(m.ref)} aria-selected={picked.includes(m.ref)} onClick={() => toggle(m.ref)} data-person={m.ref}>
            <Avatar name={m.name} url={m.avatarUrl} size={34} />
            <span>{m.name}{m.title && <small> · {m.title}</small>}</span>
            <span className="msheet-tick" aria-hidden="true">{picked.includes(m.ref) && <Icon name="check" size={13} />}</span>
          </button>
        ))}
      </div>
      <button type="button" className="msheet-go" disabled={!picked.length} onClick={() => onStart(picked)} data-start="1">
        {picked.length > 1 ? t('Start a group of {n}', { n: picked.length + 1 }) : t('Start')}
      </button>
    </Sheet>
  )
}
