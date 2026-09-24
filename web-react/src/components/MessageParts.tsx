import React, { useEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import type { ChannelMessage } from '../types/card'

// The pieces of a message a chat client has and a plain log does not:
// formatting, reactions, the emoji picker, and the bar of things you can do
// to a message on hover. ClassicList puts them together.

/// The reactions most people reach for, first in the bar as in Slack.
export const QUICK_REACTIONS = ['✅', '👀', '🙌']

/// A small, fixed set rather than the whole Unicode table: enough to answer
/// with, and it opens instantly.
const EMOJI_SETS: Array<{ label: string; list: string[] }> = [
  { label: 'Frequently used', list: ['👍', '✅', '👀', '🙌', '🎉', '🙏', '❤️', '😂', '🔥', '💯', '👏', '🚀'] },
  { label: 'Work', list: ['📌', '📎', '📅', '⏰', '💡', '❓', '❗', '⚠️', '🛑', '✍️', '📈', '💰', '🧾', '📦', '🤝', '🗳️'] },
  { label: 'Feelings', list: ['😀', '😊', '😅', '🤔', '😮', '😢', '😬', '🙃', '😎', '🥳', '😴', '🤯'] },
  { label: 'Answers', list: ['⭕', '❌', '🆗', '🆖', '👌', '👎', '🤞', '💪', '☕', '🍣', '🍺', '🌱'] },
]

export const EmojiPicker: React.FC<{ onPick: (emoji: string) => void; onClose: () => void }> = ({ onPick, onClose }) => {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [onClose])
  return (
    <div className="slk-picker" ref={box} role="dialog" aria-label={t('Add reaction')}>
      {EMOJI_SETS.map((set) => (
        <div key={set.label} className="slk-picker-set">
          <div className="slk-picker-label">{t(set.label)}</div>
          <div className="slk-picker-grid">
            {set.list.map((e) => (
              <button key={e} type="button" className="slk-picker-emoji" onClick={() => { onPick(e); onClose() }} aria-label={e}>{e}</button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}

/// The pills under a message: each emoji, how many, and whether you are one.
export const Reactions: React.FC<{
  message: ChannelMessage
  nameOf: (ref: string) => string
  onToggle: (emoji: string) => void
  onAdd: () => void
}> = ({ message, nameOf, onToggle, onAdd }) => {
  const t = useT()
  const list = message.reactions || []
  if (!list.length) return null
  return (
    <div className="slk-reactions">
      {list.map((r) => (
        <button
          key={r.emoji}
          type="button"
          className={`slk-reaction${r.mine ? ' mine' : ''}`}
          aria-pressed={r.mine}
          title={r.refs.map(nameOf).join(', ')}
          onClick={() => onToggle(r.emoji)}
        >
          <span className="slk-reaction-emoji">{r.emoji}</span>
          <span className="slk-reaction-count">{r.count}</span>
        </button>
      ))}
      <button type="button" className="slk-reaction add" onClick={onAdd} aria-label={t('Add reaction')}>
        <span aria-hidden="true">☺︎+</span>
      </button>
    </div>
  )
}

/// Everything you can do to one message, on hover — reactions, a thread,
/// a pin, and behind ⋯ the rest: edit, delete, copy, make it a decision.
export const MessageActions: React.FC<{
  message: ChannelMessage
  inThread?: boolean
  onReact: (emoji: string) => void
  onReply?: () => void
  onPin?: () => void
  onEdit?: () => void
  onDelete?: () => void
  onDecide?: () => void
  onOpenChange: (open: boolean) => void
}> = ({ message, inThread, onReact, onReply, onPin, onEdit, onDelete, onDecide, onOpenChange }) => {
  const t = useT()
  const [picker, setPicker] = useState(false)
  const [menu, setMenu] = useState(false)
  const menuBox = useRef<HTMLDivElement>(null)
  useEffect(() => { onOpenChange(picker || menu) }, [picker, menu, onOpenChange])
  useEffect(() => {
    if (!menu) return
    const down = (e: MouseEvent) => { if (menuBox.current && !menuBox.current.contains(e.target as Node)) setMenu(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(false) }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [menu])
  const copy = () => { void navigator.clipboard?.writeText(message.body); setMenu(false) }
  return (
    <>
      {QUICK_REACTIONS.map((e) => (
        <button key={e} type="button" className="slk-tool emoji" onClick={() => onReact(e)} title={t('React with {emoji}', { emoji: e })} aria-label={t('React with {emoji}', { emoji: e })}>{e}</button>
      ))}
      <button type="button" className="slk-tool" onClick={() => setPicker((p) => !p)} title={t('Add reaction')} aria-label={t('Add reaction')} aria-expanded={picker}>☺︎</button>
      {onReply && !inThread && (
        <button type="button" className="slk-tool" onClick={onReply} title={t('Reply in thread')} aria-label={t('Reply in thread')}>💬</button>
      )}
      {onPin && !inThread && (
        <button type="button" className={`slk-tool${message.pinned ? ' on' : ''}`} onClick={onPin} title={message.pinned ? t('Unpin') : t('Pin to channel')} aria-label={message.pinned ? t('Unpin') : t('Pin to channel')}>📌</button>
      )}
      <div className="slk-tool-menu-wrap" ref={menuBox}>
        <button type="button" className="slk-tool" onClick={() => setMenu((m) => !m)} aria-label={t('More actions')} aria-expanded={menu} aria-haspopup="menu">⋯</button>
        {menu && (
          <div className="slk-menu" role="menu">
            {onEdit && <button type="button" role="menuitem" onClick={() => { setMenu(false); onEdit() }}>{t('Edit message')}<kbd>E</kbd></button>}
            {onReply && !inThread && <button type="button" role="menuitem" onClick={() => { setMenu(false); onReply() }}>{t('Reply in thread')}<kbd>T</kbd></button>}
            {onDecide && <button type="button" role="menuitem" onClick={() => { setMenu(false); onDecide() }}>{t('Make it a decision')}</button>}
            {onPin && !inThread && <button type="button" role="menuitem" onClick={() => { setMenu(false); onPin() }}>{message.pinned ? t('Unpin') : t('Pin to channel')}<kbd>P</kbd></button>}
            {message.body && <button type="button" role="menuitem" onClick={copy}>{t('Copy text')}</button>}
            {onDelete && <div className="slk-menu-sep" />}
            {onDelete && <button type="button" role="menuitem" className="danger" onClick={() => { setMenu(false); onDelete() }}>{t('Delete message')}<kbd>⌫</kbd></button>}
          </div>
        )}
      </div>
      {picker && <EmojiPicker onPick={onReact} onClose={() => setPicker(false)} />}
    </>
  )
}

/// Wrap what is selected in a textarea with a mark — the composer's B, I,
/// S and code — or put the mark at the caret when nothing is.
export function wrapSelection(el: HTMLTextAreaElement | null, value: string, set: (v: string) => void, before: string, after = before) {
  if (!el) return
  const start = el.selectionStart ?? value.length
  const end = el.selectionEnd ?? value.length
  const picked = value.slice(start, end)
  const next = value.slice(0, start) + before + picked + after + value.slice(end)
  set(next)
  requestAnimationFrame(() => {
    el.focus()
    const caret = picked ? start + before.length + picked.length + after.length : start + before.length
    el.setSelectionRange(picked ? start + before.length : caret, picked ? start + before.length + picked.length : caret)
  })
}

/// Start each selected line with a mark: a list, a quote.
export function prefixLines(el: HTMLTextAreaElement | null, value: string, set: (v: string) => void, mark: string) {
  if (!el) return
  const start = value.lastIndexOf('\n', (el.selectionStart ?? 0) - 1) + 1
  const endRaw = value.indexOf('\n', el.selectionEnd ?? value.length)
  const end = endRaw === -1 ? value.length : endRaw
  const block = value.slice(start, end).split('\n').map((l) => (l.startsWith(mark) ? l : mark + l)).join('\n')
  set(value.slice(0, start) + block + value.slice(end))
  requestAnimationFrame(() => { el.focus(); el.setSelectionRange(start + block.length, start + block.length) })
}

export const FormatBar: React.FC<{ target: React.RefObject<HTMLTextAreaElement>; value: string; set: (v: string) => void }> = ({ target, value, set }) => {
  const t = useT()
  const b = (label: string, title: string, act: () => void, cls = '') => (
    <button type="button" className={`slk-fmt ${cls}`} title={title} aria-label={title} onMouseDown={(e) => e.preventDefault()} onClick={act}>{label}</button>
  )
  return (
    <div className="slk-format" role="toolbar" aria-label={t('Formatting')}>
      {b('B', t('Bold'), () => wrapSelection(target.current, value, set, '*'), 'bold')}
      {b('I', t('Italic'), () => wrapSelection(target.current, value, set, '_'), 'italic')}
      {b('S', t('Strikethrough'), () => wrapSelection(target.current, value, set, '~'), 'strike')}
      {b('</>', t('Code'), () => wrapSelection(target.current, value, set, '`'), 'code')}
      {b('❝', t('Quote'), () => prefixLines(target.current, value, set, '> '))}
      {b('•', t('Bulleted list'), () => prefixLines(target.current, value, set, '- '))}
    </div>
  )
}

/// Slack's formatting, read back: *bold*, _italic_, ~strike~, `code`,
/// ```blocks```, "> " quotes and "- " lists — plus links and @names.
export function renderRich(text: string, mentionClass: (name: string) => string): React.ReactNode {
  const out: React.ReactNode[] = []
  const parts = text.split(/```/)
  parts.forEach((chunk, ci) => {
    if (ci % 2 === 1) {
      out.push(<pre key={`pre-${ci}`} className="slk-pre"><code>{chunk.replace(/^\n/, '')}</code></pre>)
      return
    }
    const lines = chunk.split('\n')
    let list: React.ReactNode[] = []
    const flush = (k: string) => { if (list.length) { out.push(<ul key={`ul-${k}`} className="slk-ul">{list}</ul>); list = [] } }
    lines.forEach((line, li) => {
      const key = `${ci}-${li}`
      const bullet = /^\s*[-•*]\s+(.*)$/.exec(line)
      if (bullet && !/^\*[^*]+\*/.test(line.trim())) { list.push(<li key={key}>{inline(bullet[1], mentionClass)}</li>); return }
      flush(key)
      const quote = /^>\s?(.*)$/.exec(line)
      if (quote) { out.push(<blockquote key={key} className="slk-quote">{inline(quote[1], mentionClass)}</blockquote>); return }
      if (li > 0 || (ci > 0 && line)) out.push(<br key={`br-${key}`} />)
      out.push(<React.Fragment key={key}>{inline(line, mentionClass)}</React.Fragment>)
    })
    flush(`end-${ci}`)
  })
  // A leading <br> left by a block before it is noise.
  while (out.length && React.isValidElement(out[0]) && (out[0] as React.ReactElement).type === 'br') out.shift()
  return out
}

function inline(line: string, mentionClass: (name: string) => string): React.ReactNode[] {
  const tokens = line.split(/(`[^`\n]+`|https?:\/\/[^\s<>"）」]+|[@＠][^\s@＠,，。、!?！？:;]+|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g)
  return tokens.map((part, i) => {
    if (!part) return null
    if (/^`[^`]+`$/.test(part)) return <code key={i} className="slk-code">{part.slice(1, -1)}</code>
    if (/^https?:\/\//.test(part)) return <a key={i} href={part} target="_blank" rel="noopener noreferrer">{part}</a>
    if (/^[@＠]/.test(part)) return <span key={i} className={mentionClass(part)}>{part}</span>
    if (/^\*[^*]+\*$/.test(part)) return <b key={i}>{inline(part.slice(1, -1), mentionClass)}</b>
    if (/^_[^_]+_$/.test(part)) return <i key={i}>{inline(part.slice(1, -1), mentionClass)}</i>
    if (/^~[^~]+~$/.test(part)) return <s key={i}>{inline(part.slice(1, -1), mentionClass)}</s>
    return <React.Fragment key={i}>{part}</React.Fragment>
  })
}
