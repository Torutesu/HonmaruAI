import React, { useEffect, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import type { ChannelMessage } from '../types/card'
import { Icon } from './Icon'
import { customEmojiUrl, useCustomEmoji, CUSTOM_EMOJI } from '../utils/customEmoji'

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
  const custom = useCustomEmoji()
  useEffect(() => {
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose() }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [onClose])
  return (
    <div className="slk-picker" ref={box} role="dialog" aria-label={t('Add reaction')}>
      <div className="slk-picker-set workspace">
        <div className="slk-picker-label">
          {t('This workspace')}
          <a className="slk-picker-add" href="#/tools/emoji" onClick={() => onClose()} data-add-emoji="1"><Icon name="plus" size={12} /> {t('Add emoji')}</a>
        </div>
        {custom.length > 0 && (
          <div className="slk-picker-grid">
            {custom.map((e) => (
              <button key={e.name} type="button" className="slk-picker-emoji custom" onClick={() => { onPick(`:${e.name}:`); onClose() }} aria-label={`:${e.name}:`} title={`:${e.name}:`} data-custom-emoji={e.name}>
                <img src={e.url} alt={`:${e.name}:`} loading="lazy" draggable={false} />
              </button>
            ))}
          </div>
        )}
      </div>
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
/// An emoji as it is drawn: the character, or this workspace's picture for
/// a `:name:` it has.
export const EmojiGlyph: React.FC<{ emoji: string; size?: number }> = ({ emoji, size }) => {
  useCustomEmoji()
  const url = CUSTOM_EMOJI.test(emoji) ? customEmojiUrl(emoji) : null
  if (!url) return <>{emoji}</>
  return <img className="slk-custom-emoji" src={url} alt={emoji} title={emoji} draggable={false} style={size ? { width: size, height: size } : undefined} />
}

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
          <span className="slk-reaction-emoji"><EmojiGlyph emoji={r.emoji} /></span>
          <span className="slk-reaction-count">{r.count}</span>
        </button>
      ))}
      <button type="button" className="slk-reaction add" onClick={onAdd} aria-label={t('Add reaction')}>
        <Icon name="smile" size={14} /><span aria-hidden="true">+</span>
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
  /// Save for later; with a time, come back as a card then.
  onLater?: (remindAt: string | null) => void
  /// Add to the clip being gathered for one decision.
  onClip?: () => void
  clipped?: boolean
  onOpenChange: (open: boolean) => void
}> = ({ message, inThread, onReact, onReply, onPin, onEdit, onDelete, onDecide, onLater, onClip, clipped, onOpenChange }) => {
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
      <button type="button" className="slk-tool" onClick={() => setPicker((p) => !p)} title={t('Add reaction')} aria-label={t('Add reaction')} aria-expanded={picker}><Icon name="smile" size={16} /></button>
      {onReply && !inThread && (
        <button type="button" className="slk-tool" onClick={onReply} title={t('Reply in thread')} aria-label={t('Reply in thread')}><Icon name="message" size={16} /></button>
      )}
      {onPin && !inThread && (
        <button type="button" className={`slk-tool${message.pinned ? ' on' : ''}`} onClick={onPin} title={message.pinned ? t('Unpin') : t('Pin to channel')} aria-label={message.pinned ? t('Unpin') : t('Pin to channel')}><Icon name="pin" size={16} /></button>
      )}
      <div className="slk-tool-menu-wrap" ref={menuBox}>
        <button type="button" className="slk-tool" onClick={() => setMenu((m) => !m)} aria-label={t('More actions')} aria-expanded={menu} aria-haspopup="menu"><Icon name="more" size={16} /></button>
        {menu && (
          <div className="slk-menu" role="menu">
            {onEdit && <button type="button" role="menuitem" onClick={() => { setMenu(false); onEdit() }}>{t('Edit message')}<kbd>E</kbd></button>}
            {onReply && !inThread && <button type="button" role="menuitem" onClick={() => { setMenu(false); onReply() }}>{t('Reply in thread')}<kbd>T</kbd></button>}
            {onDecide && <button type="button" role="menuitem" onClick={() => { setMenu(false); onDecide() }}>{t('Make it a decision')}</button>}
            {onPin && !inThread && <button type="button" role="menuitem" onClick={() => { setMenu(false); onPin() }}>{message.pinned ? t('Unpin') : t('Pin to channel')}<kbd>P</kbd></button>}
            {onClip && <button type="button" role="menuitem" onClick={() => { setMenu(false); onClip() }}>{clipped ? t('Remove from clip') : t('Add to clip')}</button>}
            {onLater && (
              <>
                <div className="slk-menu-sep" />
                <button type="button" role="menuitem" onClick={() => { setMenu(false); onLater(null) }}>{t('Save for later')}</button>
                <button type="button" role="menuitem" onClick={() => { setMenu(false); onLater(new Date(Date.now() + 3600000).toISOString()) }}>{t('Remind me in 1 hour')}</button>
                <button type="button" role="menuitem" onClick={() => { setMenu(false); onLater(tomorrowAt(9)) }}>{t('Remind me tomorrow at 9:00')}</button>
                <div className="slk-menu-sep" />
              </>
            )}
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
  const b = (label: React.ReactNode, title: string, act: () => void, cls = '') => (
    <button type="button" className={`slk-fmt ${cls}`} title={title} aria-label={title} onMouseDown={(e) => e.preventDefault()} onClick={act}>{label}</button>
  )
  return (
    <div className="slk-format" role="toolbar" aria-label={t('Formatting')}>
      {b('B', t('Bold'), () => wrapSelection(target.current, value, set, '*'), 'bold')}
      {b('I', t('Italic'), () => wrapSelection(target.current, value, set, '_'), 'italic')}
      {b('S', t('Strikethrough'), () => wrapSelection(target.current, value, set, '~'), 'strike')}
      {b(<Icon name="code" size={14} />, t('Code'), () => wrapSelection(target.current, value, set, '`'), 'code')}
      {b(<Icon name="quote" size={13} />, t('Quote'), () => prefixLines(target.current, value, set, '> '))}
      {b(<Icon name="list" size={14} />, t('Bulleted list'), () => prefixLines(target.current, value, set, '- '))}
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
    // A list or a quote ends its own line: the line after it needs no break
    // of its own, or a blank line after a list reads as two.
    let afterBlock = false
    const flush = (k: string) => { if (list.length) { out.push(<ul key={`ul-${k}`} className="slk-ul">{list}</ul>); list = []; afterBlock = true } }
    lines.forEach((line, li) => {
      const key = `${ci}-${li}`
      const bullet = /^\s*[-•*]\s+(.*)$/.exec(line)
      if (bullet && !/^\*[^*]+\*/.test(line.trim())) { list.push(<li key={key}>{inline(bullet[1], mentionClass)}</li>); return }
      flush(key)
      const quote = /^>\s?(.*)$/.exec(line)
      if (quote) { out.push(<blockquote key={key} className="slk-quote">{inline(quote[1], mentionClass)}</blockquote>); afterBlock = true; return }
      if (afterBlock) { afterBlock = false; out.push(<React.Fragment key={key}>{inline(line, mentionClass)}</React.Fragment>); return }
      if (li > 0 || (ci > 0 && line)) out.push(<br key={`br-${key}`} />)
      out.push(<React.Fragment key={key}>{inline(line, mentionClass)}</React.Fragment>)
    })
    flush(`end-${ci}`)
  })
  // A leading <br> left by a block before it is noise.
  while (out.length && React.isValidElement(out[0]) && (out[0] as React.ReactElement).type === 'br') out.shift()
  return out
}

const JAM_AUDIO = /^https?:\/\/[^\s]+\/channels\/jam\/audio\/[0-9a-f-]{36}$/

function inline(line: string, mentionClass: (name: string) => string): React.ReactNode[] {
  const tokens = line.split(/(`[^`\n]+`|https?:\/\/[^\s<>"）」]+|:[a-z0-9_+-]{1,30}:|[@＠][^\s@＠,，。、!?！？:;]+|\*[^*\n]+\*|_[^_\n]+_|~[^~\n]+~)/g)
  // A line that is nothing but this workspace's emoji draws them large.
  const onlyEmoji = tokens.every((p) => !p || !p.trim() || (CUSTOM_EMOJI.test(p) && Boolean(customEmojiUrl(p))))
  return tokens.map((part, i) => {
    if (!part) return null
    if (/^`[^`]+`$/.test(part)) return <code key={i} className="slk-code">{part.slice(1, -1)}</code>
    if (CUSTOM_EMOJI.test(part)) {
      const url = customEmojiUrl(part)
      if (url) return <img key={i} className={`slk-custom-emoji${onlyEmoji ? ' big' : ''}`} src={url} alt={part} title={part} draggable={false} />
      return <React.Fragment key={i}>{part}</React.Fragment>
    }
    // A Jam's recording plays where it was posted.
    if (JAM_AUDIO.test(part)) return <audio key={i} className="slk-jam-audio" controls preload="none" src={part} />
    if (/^https?:\/\//.test(part)) return <a key={i} href={part} target="_blank" rel="noopener noreferrer">{part}</a>
    if (/^[@＠]/.test(part)) return <span key={i} className={mentionClass(part)}>{part}</span>
    if (/^\*[^*]+\*$/.test(part)) return <b key={i}>{inline(part.slice(1, -1), mentionClass)}</b>
    if (/^_[^_]+_$/.test(part)) return <i key={i}>{inline(part.slice(1, -1), mentionClass)}</i>
    if (/^~[^~]+~$/.test(part)) return <s key={i}>{inline(part.slice(1, -1), mentionClass)}</s>
    return <React.Fragment key={i}>{part}</React.Fragment>
  })
}

/// Tomorrow at an hour, in this browser's time.
export function tomorrowAt(hour: number): string {
  const d = new Date()
  d.setDate(d.getDate() + 1)
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}

/// Next Monday at an hour.
export function nextMondayAt(hour: number): string {
  const d = new Date()
  const add = ((8 - d.getDay()) % 7) || 7
  d.setDate(d.getDate() + add)
  d.setHours(hour, 0, 0, 0)
  return d.toISOString()
}

/// The commands a composer understands after "/".
export const SLASH_COMMANDS: Array<{ name: string; hint: string; example: string }> = [
  { name: 'decide', hint: 'Send this as a decision for whoever should make it', example: '/decide approve the Friday price change' },
  { name: 'remember', hint: 'Add a rule to the playbook your AI follows', example: '/remember invoices under ¥50,000 go to Kenji' },
  { name: 'routine', hint: 'Have your AI do something on a schedule', example: '/routine every Monday at 9 summarise last week' },
  { name: 'schedule', hint: 'Send a message later: 30m, 1h, 2h, tomorrow, monday', example: '/schedule tomorrow Morning all, doors at 8' },
  { name: 'shortcuts', hint: 'Show keyboard shortcuts', example: '/shortcuts' },
]

/// "/schedule 1h text" → when and what, or null when the time is not one we read.
export function parseScheduleCommand(rest: string): { at: string; text: string } | null {
  const m = /^(\d+)\s*(m|min|h|hr|hours?)\s+([\s\S]+)$/i.exec(rest.trim())
  if (m) {
    const n = Number(m[1]); const unit = m[2].toLowerCase().startsWith('h') ? 3600000 : 60000
    return { at: new Date(Date.now() + n * unit).toISOString(), text: m[3].trim() }
  }
  const w = /^(tomorrow|明日|monday|月曜)\s+([\s\S]+)$/i.exec(rest.trim())
  if (w) return { at: /^(monday|月曜)$/i.test(w[1]) ? nextMondayAt(9) : tomorrowAt(9), text: w[2].trim() }
  return null
}

/// The menu of commands while "/" is being typed at the start of a message.
export const SlashMenu: React.FC<{ draft: string; onPick: (name: string) => void }> = ({ draft, onPick }) => {
  const t = useT()
  const m = /^\/(\w*)$/.exec(draft)
  if (!m) return null
  const list = SLASH_COMMANDS.filter((c) => c.name.startsWith(m[1].toLowerCase()))
  if (!list.length) return null
  return (
    <div className="slk-slash" role="listbox" aria-label={t('Commands')}>
      {list.map((c) => (
        <button key={c.name} type="button" role="option" className="slk-slash-item" onMouseDown={(e) => e.preventDefault()} onClick={() => onPick(c.name)}>
          <b>/{c.name}</b>
          <span>{t(c.hint)}</span>
        </button>
      ))}
    </div>
  )
}

/// When to send: the few times people pick, and any other.
export const SchedulePicker: React.FC<{ onPick: (at: string) => void; onClose: () => void }> = ({ onPick, onClose }) => {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  const [custom, setCustom] = useState('')
  useEffect(() => {
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose() }
    document.addEventListener('mousedown', down)
    return () => document.removeEventListener('mousedown', down)
  }, [onClose])
  const opt = (label: string, at: string) => (
    <button type="button" role="menuitem" onClick={() => { onPick(at); onClose() }}>{label}<span>{new Date(at).toLocaleString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })}</span></button>
  )
  return (
    <div className="slk-menu slk-schedule" ref={box} role="menu" aria-label={t('Schedule message')}>
      <div className="slk-menu-title">{t('Schedule message')}</div>
      {opt(t('In 30 minutes'), new Date(Date.now() + 30 * 60000).toISOString())}
      {opt(t('In 1 hour'), new Date(Date.now() + 3600000).toISOString())}
      {opt(t('Tomorrow at 9:00'), tomorrowAt(9))}
      {opt(t('Monday at 9:00'), nextMondayAt(9))}
      <div className="slk-menu-sep" />
      <form className="slk-schedule-custom" onSubmit={(e) => { e.preventDefault(); if (custom) { onPick(new Date(custom).toISOString()); onClose() } }}>
        <input type="datetime-local" value={custom} onChange={(e) => setCustom(e.target.value)} aria-label={t('Custom time')} />
        <button type="submit" disabled={!custom}>{t('Schedule')}</button>
      </form>
    </div>
  )
}
