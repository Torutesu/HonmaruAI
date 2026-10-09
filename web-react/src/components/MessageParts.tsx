import React, { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { getLocale } from '../utils/locale'
import { useT } from '../utils/i18n'
import type { ChannelMessage, ReplyQuote } from '../types/card'
import { Icon } from './Icon'
import { customEmojiUrl, useCustomEmoji, CUSTOM_EMOJI } from '../utils/customEmoji'
import { typingLine, announce, ANNOUNCE_GAP_MS } from '../utils/typing'
import type { Announced } from '../utils/typing'
import { excerptParts } from '../utils/replies'
import { messageMenuEntries, type MessageMenuActions } from '../utils/messageMenu'
import { keepOnScreen, focusGoesBack } from './RowMenu'
import { emojiDataState, gridStep, isEmojiOnly, loadEmojiData, pickerSections, rememberEmoji, useEmojiData, useEmojiDataState, useQuickReactions, useRecentEmoji } from '../utils/emojiSearch'
import { composing } from '../utils/keys'

// The pieces of a message a chat client has and a plain log does not:
// formatting, reactions, the emoji picker, and the bar of things you can do
// to a message on hover. ClassicList puts them together.

/// Cells to a row in the picker's grids, as ClassicList.css lays them out.
const PICKER_COLS = 8
const PICKER_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'])

/// Every emoji to react with: a search box on top, this workspace's own
/// first, the ones you used lately, then the list by group. Typing turns it
/// into one grid of what matches, and Enter takes the first. The arrows move
/// through the grids, and Tab leaves them in one step. Until the list is
/// here it says so, and offers to fetch it again if it did not come.
export const EmojiPicker: React.FC<{ onPick: (emoji: string) => void; onClose: () => void }> = ({ onPick, onClose }) => {
  const t = useT()
  const box = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  const custom = useCustomEmoji()
  const recent = useRecentEmoji()
  const data = useEmojiData()
  const listState = useEmojiDataState()
  const [query, setQuery] = useState('')
  const [active, setActive] = useState(0)
  const id = useId()
  // Closed by a key or a pick, focus goes back to what opened the picker; a
  // click somewhere else leaves it where the click put it.
  const giveBack = useRef(false)
  const sections = useMemo(() => pickerSections(query, custom, recent, data), [query, custom, recent, data])
  const sizes = sections.map((s) => s.cells.length)
  const starts = sizes.map((_, i) => sizes.slice(0, i).reduce((a, b) => a + b, 0))
  const total = sizes.reduce((a, b) => a + b, 0)
  const current = Math.min(active, Math.max(0, total - 1))
  const searching = Boolean(query.trim())
  useEffect(() => {
    const down = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) onClose() }
    // Esc closes the picker and nothing under it: not the thread beside the
    // message (the window's Esc), which a picker opened with + sits over —
    // and not while an input method is composing, where Esc cancels that.
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !composing(e)) { e.preventDefault(); e.stopPropagation(); onClose() } }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [onClose])
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // Not on a phone, whose keyboard would come up over the picker.
    if (!window.matchMedia?.('(pointer: coarse)').matches) search.current?.focus({ preventScroll: true })
    return () => { if (giveBack.current && opener?.isConnected) opener.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => { setActive(0); if (box.current) box.current.scrollTop = 0 }, [query])
  // A list that did not come — offline, or a deploy replaced its chunk — is
  // asked for again as the search changes, not only when the picker reopens.
  useEffect(() => { if (emojiDataState() === 'failed') void loadEmojiData() }, [query])
  const pick = (emoji: string) => {
    rememberEmoji(emoji)
    giveBack.current = true
    onPick(emoji)
    onClose()
  }
  const focusCell = (i: number) => box.current?.querySelector<HTMLElement>(`[data-cell="${i}"]`)?.focus()
  const onKeyDown = (e: React.KeyboardEvent) => {
    // Keys that are choosing a word in an input method are its own.
    if (composing(e)) return
    if (e.key === 'Escape') {
      // The picker's, not the pane's behind it: a search clears first.
      e.stopPropagation()
      if (query) { setQuery(''); search.current?.focus() } else { giveBack.current = true; onClose() }
      return
    }
    if (e.target === search.current) {
      if (e.key === 'ArrowDown' && total) { e.preventDefault(); focusCell(current) }
      if (e.key === 'Enter' && searching) {
        e.preventDefault()
        const first = sections[0]?.cells[0]
        if (first) pick(first.emoji)
      }
      return
    }
    const at = Number((e.target as HTMLElement).dataset.cell)
    // ⌥↑ and the like are still the chat's (between conversations).
    if (!Number.isInteger(at) || !PICKER_KEYS.has(e.key) || e.altKey || e.metaKey || e.ctrlKey) return
    // An arrow that moved in the grid does not also move the list behind it.
    e.preventDefault()
    e.stopPropagation()
    const next = gridStep(sizes, at, e.key, PICKER_COLS)
    if (next < 0) search.current?.focus()
    else focusCell(next)
  }
  return (
    <div className="slk-picker" ref={box} role="dialog" aria-label={t('Add reaction')} onKeyDown={onKeyDown}>
      <div className="slk-picker-head">
        <input
          ref={search}
          className="slk-picker-search"
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('Search emoji')}
          aria-label={t('Search emoji')}
          autoComplete="off"
          spellCheck={false}
          data-emoji-search
        />
      </div>
      {sections.map((s, si) => (s.cells.length > 0 || s.workspace) && (
        <div key={s.label} className={`slk-picker-set${s.workspace ? ' workspace' : ''}`} role="group" aria-labelledby={`${id}-${si}`}>
          <div className="slk-picker-label">
            <span id={`${id}-${si}`}>{t(s.label)}</span>
            {s.workspace && <a className="slk-picker-add" href="#/tools/emoji" onClick={() => onClose()} data-add-emoji="1"><Icon name="plus" size={12} /> {t('Add emoji')}</a>}
          </div>
          {s.cells.length > 0 && (
            <div className="slk-picker-grid">
              {s.cells.map((c, ci) => {
                const i = starts[si] + ci
                return (
                  <button
                    key={c.emoji}
                    type="button"
                    className={`slk-picker-emoji${c.url ? ' custom' : ''}`}
                    onClick={() => pick(c.emoji)}
                    onFocus={() => setActive(i)}
                    tabIndex={i === current ? 0 : -1}
                    aria-label={c.emoji}
                    title={c.name ? `:${c.name}:` : undefined}
                    data-cell={i}
                    data-custom-emoji={c.url ? c.name : undefined}
                  >
                    {c.url ? <img src={c.url} alt={c.emoji} loading="lazy" draggable={false} /> : c.emoji}
                  </button>
                )
              })}
            </div>
          )}
        </div>
      ))}
      {/* Nothing matches only once there is a list to match against. */}
      {listState === 'ready' && searching && !total && <p className="slk-picker-empty" role="status">{t('Nothing matches that.')}</p>}
      {listState === 'loading' && <p className="slk-picker-empty" role="status" data-emoji-list="loading">{t('Loading…')}</p>}
      {listState === 'failed' && (
        <p className="slk-picker-empty" role="alert" data-emoji-list="failed">
          {t('The emoji list did not load.')} <button type="button" className="slk-picker-retry" onClick={() => void loadEmojiData()}>{t('Try again')}</button>
        </p>
      )}
    </div>
  )
}

/// The whole picker by itself at a point: where a message's right-click
/// menu was, opened from the smile along its top. It is fixed to the window
/// there and kept on screen, and drawn once, not under the message, which
/// may be far down the page or drawn twice (a thread's first message is in
/// the channel and in the thread, and two pickers shut each other). The
/// focus goes to its first emoji, so a keyboard that opened the menu
/// carries on into it, and back to the message when it shuts.
export const EmojiPickerAt: React.FC<{ at: { x: number; y: number }; onPick: (emoji: string) => void; onClose: () => void }> = ({ at, onPick, onClose }) => {
  const ref = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number }>({ left: at.x, top: at.y })
  useLayoutEffect(() => {
    const el = ref.current
    if (el) setPlace(keepOnScreen(at, el.getBoundingClientRect(), { width: window.innerWidth, height: window.innerHeight }))
  }, [at.x, at.y])
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    const box = ref.current
    box?.querySelector<HTMLButtonElement>('.slk-picker-emoji')?.focus({ preventScroll: true })
    return () => { if (focusGoesBack(before, document.activeElement, document.body, box)) before!.focus({ preventScroll: true }) }
  }, [])
  return (
    <div ref={ref} className="slk-picker-at" style={place}>
      <EmojiPicker onPick={onPick} onClose={onClose} />
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

/// Who reacted, as a sentence: "Aya, Ken, and you", with the rest counted
/// when there are many.
export function reactorNames(names: string[], locale: string, more: (n: number) => string, max = 12): string {
  const shown = names.slice(0, max)
  const rest = names.length - shown.length
  const parts = rest > 0 ? [...shown, more(rest)] : shown
  try { return new Intl.ListFormat(locale, { style: 'long', type: 'conjunction' }).format(parts) } catch { return parts.join(', ') }
}

/// Hovering a reaction, as in Slack: the emoji large, and who reacted with it.
const ReactionTip: React.FC<{ emoji: string; names: string[]; anchor: DOMRect }> = ({ emoji, names, anchor }) => {
  const t = useT()
  const custom = CUSTOM_EMOJI.test(emoji)
  const who = reactorNames(names, getLocale(), (n) => t('{n} others', { n }))
  const line = custom ? t('{names} reacted with {emoji}', { emoji }) : t('{names} reacted')
  const [before, after = ''] = line.split('{names}')
  const width = 240
  const left = Math.max(8, Math.min(anchor.left + anchor.width / 2 - width / 2, window.innerWidth - width - 8))
  const above = anchor.top > 180
  return createPortal(
    <div
      className="slk-react-tip"
      role="tooltip"
      style={{ left, width, ...(above ? { bottom: window.innerHeight - anchor.top + 8 } : { top: anchor.bottom + 8 }) }}
      data-reaction-tip
    >
      <span className="slk-react-tip-emoji" aria-hidden="true"><EmojiGlyph emoji={emoji} size={56} /></span>
      <p>{before}<b>{who}</b>{after}</p>
    </div>,
    document.body,
  )
}

export const Reactions: React.FC<{
  message: ChannelMessage
  nameOf: (ref: string) => string
  onToggle: (emoji: string) => void
  onAdd: () => void
}> = ({ message, nameOf, onToggle, onAdd }) => {
  const t = useT()
  const [tip, setTip] = useState<{ emoji: string; anchor: DOMRect } | null>(null)
  const list = message.reactions || []
  // A reaction that goes (or changes) while its tip is up takes the tip too.
  useEffect(() => { if (tip && !list.some((r) => r.emoji === tip.emoji)) setTip(null) }, [list, tip])
  if (!list.length) return null
  const shown = tip && list.find((r) => r.emoji === tip.emoji)
  const open = (emoji: string) => (e: React.SyntheticEvent<HTMLElement>) => setTip({ emoji, anchor: e.currentTarget.getBoundingClientRect() })
  return (
    <div className="slk-reactions">
      {list.map((r) => (
        <button
          key={r.emoji}
          type="button"
          className={`slk-reaction${r.mine ? ' mine' : ''}${message.reactionsPending?.includes(r.emoji) ? ' pending' : ''}`}
          aria-pressed={r.mine}
          aria-label={t('{names} reacted', { names: reactorNames(r.refs.map(nameOf), getLocale(), (n) => t('{n} others', { n })) })}
          onMouseEnter={open(r.emoji)}
          onMouseLeave={() => setTip(null)}
          onFocus={open(r.emoji)}
          onBlur={() => setTip(null)}
          onClick={() => onToggle(r.emoji)}
          data-reaction={r.emoji}
        >
          <span className="slk-reaction-emoji"><EmojiGlyph emoji={r.emoji} /></span>
          <span className="slk-reaction-count">{r.count}</span>
        </button>
      ))}
      {shown && tip && <ReactionTip emoji={shown.emoji} names={shown.refs.map(nameOf)} anchor={tip.anchor} />}
      <button type="button" className="slk-reaction add" onClick={onAdd} aria-label={t('Add reaction')}>
        <Icon name="smile" size={14} /><span aria-hidden="true">+</span>
      </button>
    </div>
  )
}

/// First in the hover bar, as in Slack: the three emoji you reacted with
/// last, or the usual three until you have.
export const QuickReactions: React.FC<{ onReact: (emoji: string) => void }> = ({ onReact }) => {
  const t = useT()
  const quick = useQuickReactions()
  return (
    <>
      {quick.map((e) => (
        <button key={e} type="button" className="slk-tool emoji" onClick={() => onReact(e)} title={t('React with {emoji}', { emoji: e })} aria-label={t('React with {emoji}', { emoji: e })}>
          <EmojiGlyph emoji={e} size={18} />
        </button>
      ))}
    </>
  )
}

/// Tells its owner when a message's picker or menu opens or closes — only
/// then. It used to tell on every draw, because the owner hands a new
/// function each time: every row of a conversation set the list's state
/// once per draw, and that drew the whole list a second time, every time.
function useOpenChange(open: boolean, onOpenChange: (open: boolean) => void) {
  const latest = useRef(onOpenChange)
  latest.current = onOpenChange
  const told = useRef(false)
  useEffect(() => {
    if (open === told.current) return
    told.current = open
    latest.current(open)
  }, [open])
}

/// Everything you can do to one message, on hover — reactions, a reply, a
/// thread, a pin, and behind ⋯ the rest: edit, delete, copy, make it a
/// decision. What is behind ⋯ is the one list the right-click menu and a
/// phone's long press draw too.
export const MessageActions: React.FC<MessageMenuActions & {
  message: ChannelMessage
  onReact: (emoji: string) => void
  onOpenChange: (open: boolean) => void
}> = ({ message, onReact, onOpenChange, ...actions }) => {
  const t = useT()
  const { inThread, onQuote, onReply, onPin } = actions
  const [picker, setPicker] = useState(false)
  const [menu, setMenu] = useState(false)
  const menuBox = useRef<HTMLDivElement>(null)
  useOpenChange(picker || menu, onOpenChange)
  useEffect(() => {
    if (!menu) return
    const down = (e: MouseEvent) => { if (menuBox.current && !menuBox.current.contains(e.target as Node)) setMenu(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !composing(e)) setMenu(false) }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [menu])
  return (
    <>
      <QuickReactions onReact={onReact} />
      <button type="button" className="slk-tool" onClick={() => setPicker((p) => !p)} title={t('Add reaction')} aria-label={t('Add reaction')} aria-expanded={picker}><Icon name="smile" size={16} /></button>
      {onQuote && (
        <button type="button" className="slk-tool" onClick={onQuote} title={t('Reply')} aria-label={t('Reply')} data-tool="quote"><Icon name="reply" size={16} /></button>
      )}
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
            {messageMenuEntries(message, { ...actions, t }).map((e, i) => (e.kind === 'sep'
              ? <div key={i} className="slk-menu-sep" />
              : e.kind === 'item' && (
                <button key={i} type="button" role="menuitem" className={e.danger ? 'danger' : undefined} data-menu={e.data} onClick={(ev) => { setMenu(false); if (e.data === 'delete') actions.onDelete?.(ev.shiftKey); else e.onSelect?.() }}>
                  {e.label}{e.hint && <kbd>{e.hint}</kbd>}
                </button>
              )))}
          </div>
        )}
      </div>
      {picker && <EmojiPicker onPick={onReact} onClose={() => setPicker(false)} />}
    </>
  )
}

/// A decision card in a conversation, on hover: react to it, open it, and
/// — for whoever may — take it back, as a message has.
export const CardActions: React.FC<{
  onReact: (emoji: string) => void
  onOpen: () => void
  onDelete?: () => void
  onOpenChange: (open: boolean) => void
}> = ({ onReact, onOpen, onDelete, onOpenChange }) => {
  const t = useT()
  const [picker, setPicker] = useState(false)
  const [menu, setMenu] = useState(false)
  const menuBox = useRef<HTMLDivElement>(null)
  useOpenChange(picker || menu, onOpenChange)
  useEffect(() => {
    if (!menu) return
    const down = (e: MouseEvent) => { if (menuBox.current && !menuBox.current.contains(e.target as Node)) setMenu(false) }
    const key = (e: KeyboardEvent) => { if (e.key === 'Escape' && !composing(e)) setMenu(false) }
    document.addEventListener('mousedown', down)
    document.addEventListener('keydown', key)
    return () => { document.removeEventListener('mousedown', down); document.removeEventListener('keydown', key) }
  }, [menu])
  return (
    <>
      <QuickReactions onReact={onReact} />
      <button type="button" className="slk-tool" onClick={() => setPicker((p) => !p)} title={t('Add reaction')} aria-label={t('Add reaction')} aria-expanded={picker}><Icon name="smile" size={16} /></button>
      <div className="slk-tool-menu-wrap" ref={menuBox}>
        <button type="button" className="slk-tool" onClick={() => setMenu((m) => !m)} aria-label={t('More actions')} aria-expanded={menu} aria-haspopup="menu" data-card-more="1"><Icon name="more" size={16} /></button>
        {menu && (
          <div className="slk-menu" role="menu">
            <button type="button" role="menuitem" onClick={() => { setMenu(false); onOpen() }}>{t('Open')}</button>
            {onDelete && <div className="slk-menu-sep" />}
            {onDelete && <button type="button" role="menuitem" className="danger" data-menu="delete-card" onClick={() => { setMenu(false); onDelete() }}>{t('Delete this card')}</button>}
          </div>
        )}
      </div>
      {picker && <EmojiPicker onPick={(e) => { setPicker(false); onReact(e) }} onClose={() => setPicker(false)} />}
    </>
  )
}

// ---- Inline replies ----
//
// Discord's Reply, not a thread: the answer goes in the conversation with a
// line above it quoting who said what. The quote comes from the Worker
// (utils/replies.ts says how it is made); these only draw it.

/// A quote's words, a hidden spoiler drawn as a bar that says what it is.
const QuoteWords: React.FC<{ excerpt: string }> = ({ excerpt }) => {
  const t = useT()
  return <>{excerptParts(excerpt).map((p, i) => (p === null
    ? <span key={i} className="slk-reply-spoiler" role="img" aria-label={t('Spoiler')} />
    : <React.Fragment key={i}>{p}</React.Fragment>))}</>
}

/// The line above an inline reply: who it answers and how that began —
/// pressed, it goes to the original — or only that the original is gone.
/// `name` is the author as this reader calls them.
export const ReplyQuoteLine: React.FC<{ quote: ReplyQuote; name: string; onJump: () => void }> = ({ quote, name, onJump }) => {
  const t = useT()
  if (quote.deleted) {
    return (
      <div className="slk-reply-quote gone" data-reply-to={quote.id}>
        <Icon name="reply" size={12} />
        <span className="slk-reply-excerpt">{t('Original message was deleted')}</span>
      </div>
    )
  }
  return (
    <button type="button" className="slk-reply-quote" onClick={onJump} title={t('Go to the message')} data-reply-to={quote.id}>
      <Icon name="reply" size={12} />
      <span className="sr-only">{t('In reply to')} </span>
      <b className="slk-reply-who">{name}</b>
      <span className="slk-reply-excerpt"><QuoteWords excerpt={quote.excerpt} /></span>
    </button>
  )
}

/// Above a thread reply that was sent to the conversation too: that it
/// answers a thread, and how the thread began — pressed, the thread opens.
export const ThreadReplyLine: React.FC<{ quote: ReplyQuote; onOpen: () => void }> = ({ quote, onOpen }) => {
  const t = useT()
  if (quote.deleted) {
    return (
      <div className="slk-reply-quote gone" data-thread-reply={quote.id}>
        <Icon name="message" size={12} />
        <span className="slk-reply-excerpt">{t('Replied to a thread that was deleted')}</span>
      </div>
    )
  }
  return (
    <button type="button" className="slk-reply-quote" onClick={onOpen} title={t('View thread')} data-thread-reply={quote.id}>
      <Icon name="message" size={12} />
      <span className="slk-reply-who">{t('Replied to a thread:')}</span>
      <span className="slk-reply-excerpt"><QuoteWords excerpt={quote.excerpt} /></span>
    </button>
  )
}

/// Over the composer while a reply is being written: what it answers, and
/// the × (or Escape) that makes it a plain message again. `textId` names
/// the words, for the composer to be described by them.
export const ReplyingBar: React.FC<{ quote: ReplyQuote; name: string; textId: string; onCancel: () => void }> = ({ quote, name, textId, onCancel }) => {
  const t = useT()
  return (
    <div className="slk-replying" data-replying={quote.id}>
      <Icon name="reply" size={13} />
      <span className="slk-replying-text" id={textId}>
        {quote.deleted ? t('Original message was deleted') : <>{t('Replying to {name}', { name })} <span className="slk-replying-excerpt"><QuoteWords excerpt={quote.excerpt} /></span></>}
      </span>
      <button type="button" className="slk-replying-cancel" onClick={onCancel} aria-label={t('Cancel reply')} title={`${t('Cancel reply')} (Esc)`}>
        <Icon name="x" size={13} />
      </button>
    </div>
  )
}

/// Under one of yours the server does not have yet: that it is on its way
/// (said, not shown — it is drawn dimmed), or why it did not go, with Retry
/// and Delete — or, refused for what it says, Edit in place of Retry, since
/// the same words would only be refused again. Still on its way at
/// `lateAt` (ms), longer than a send should take, it says so with Delete, so
/// it can be let go of rather than waited on. Any button goes once pressed;
/// pressed from the keyboard, `refocus` says where focus goes instead of
/// nowhere.
export const UnsentNote: React.FC<{
  message: ChannelMessage
  onRetry: () => void
  onDelete: () => void
  /// Back into the box it was written in, to be changed and sent again.
  onEdit?: () => void
  lateAt?: number
  refocus?: () => void
}> = ({ message, onRetry, onDelete, onEdit, lateAt, refocus }) => {
  const t = useT()
  const pressed = (act: () => void) => (e: React.MouseEvent) => { act(); if (e.detail === 0) refocus?.() }
  // Drawn again when it becomes late, if it is still on its way by then.
  const [, turnedLate] = useState(0)
  const waiting = message.pending && lateAt !== undefined ? lateAt - Date.now() : 0
  useEffect(() => {
    if (waiting <= 0) return
    const id = setTimeout(() => turnedLate((n) => n + 1), waiting)
    return () => clearTimeout(id)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [message.pending, lateAt])
  if (message.pending && lateAt !== undefined && waiting <= 0) {
    return (
      <div className="slk-unsent late" data-unsent={message.id}>
        <span className="slk-unsent-why">{t('Sending…')}</span>
        <button type="button" className="slk-unsent-act" onClick={pressed(onDelete)} data-unsent-delete="1"><Icon name="trash" size={12} />{t('Delete')}</button>
      </div>
    )
  }
  if (message.failed) {
    return (
      <div className="slk-unsent" role="alert" data-unsent={message.id}>
        <span className="slk-unsent-why">{message.failed}</span>
        {message.refused
          ? onEdit && <button type="button" className="slk-unsent-act" onClick={pressed(onEdit)} data-unsent-edit="1"><Icon name="edit" size={12} />{t('Edit')}</button>
          : <button type="button" className="slk-unsent-act" onClick={pressed(onRetry)} data-unsent-retry="1"><Icon name="refresh" size={12} />{t('Retry')}</button>}
        <button type="button" className="slk-unsent-act" onClick={pressed(onDelete)} data-unsent-delete="1"><Icon name="trash" size={12} />{t('Delete')}</button>
      </div>
    )
  }
  return message.pending ? <span className="sr-only">{t('Sending…')}</span> : null
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

/// Start each selected line with a mark — a quote, a list — or, when every
/// one of them already has it, take it off again. A numbered list counts.
export function prefixLines(el: HTMLTextAreaElement | null, value: string, set: (v: string) => void, mark: string) {
  if (!el) return
  const selStart = el.selectionStart ?? value.length
  const selEnd = el.selectionEnd ?? value.length
  const start = value.lastIndexOf('\n', selStart - 1) + 1
  // A selection that ends at the start of a line does not take that line.
  const endFrom = selEnd > selStart && value[selEnd - 1] === '\n' ? selEnd - 1 : selEnd
  const endRaw = value.indexOf('\n', endFrom)
  const end = endRaw === -1 ? value.length : endRaw
  const lines = value.slice(start, end).split('\n')
  const numbered = mark === '1. '
  const has = (l: string) => (numbered ? /^\d+\.\s/.test(l) : l.startsWith(mark))
  const strip = (l: string) => (numbered ? l.replace(/^\d+\.\s/, '') : l.slice(mark.length))
  // Any other mark comes off first: a quoted line becomes a list, not both.
  const bare = (l: string) => l.replace(/^(> ?|[-•] |\d+\.\s)/, '')
  const filled = lines.filter((l) => l.trim())
  const off = filled.length > 0 && filled.every(has)
  let n = 0
  const block = lines.map((l) => {
    if (off) return has(l) ? strip(l) : l
    if (lines.length > 1 && !l.trim()) return l
    n += 1
    return (numbered ? `${n}. ` : mark) + bare(l)
  }).join('\n')
  set(value.slice(0, start) + block + value.slice(end))
  requestAnimationFrame(() => {
    el.focus()
    if (selStart === selEnd && lines.length === 1) {
      // The caret stays where it was in the line's own words.
      const caret = Math.max(start, Math.min(start + block.length, selStart + (block.length - (end - start))))
      el.setSelectionRange(caret, caret)
    } else el.setSelectionRange(start, start + block.length)
  })
}

/// A new line inside a quote or a list carries its mark on, as every
/// editor does; a new line on a marked line with nothing on it ends the
/// quote or the list. True when it handled the key.
export function continueBlock(el: HTMLTextAreaElement, value: string, set: (v: string) => void): boolean {
  const a = el.selectionStart ?? value.length
  const b = el.selectionEnd ?? value.length
  if (a !== b) return false
  const lineStart = value.lastIndexOf('\n', a - 1) + 1
  const line = value.slice(lineStart, a)
  const m = /^(> ?|\s*[-•] |\s*\d+\.\s)/.exec(line)
  if (!m) return false
  const mark = m[1]
  if (!line.slice(mark.length).trim() && !value.slice(a).split('\n')[0].trim()) {
    const next = value.slice(0, lineStart) + value.slice(a)
    set(next)
    requestAnimationFrame(() => el.setSelectionRange(lineStart, lineStart))
    return true
  }
  const num = /^(\s*)(\d+)\.(\s)/.exec(mark)
  const carry = num ? `${num[1]}${Number(num[2]) + 1}.${num[3]}` : mark === '>' ? '> ' : mark
  const next = value.slice(0, a) + '\n' + carry + value.slice(b)
  set(next)
  const caret = a + 1 + carry.length
  requestAnimationFrame(() => el.setSelectionRange(caret, caret))
  return true
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
      {b(<Icon name="list-ordered" size={14} />, t('Numbered list'), () => prefixLines(target.current, value, set, '1. '))}
    </div>
  )
}

/// How an @name is drawn: its class — and, for a person, their ref, which
/// makes it press like a button and open their card. It stays a word of the
/// message all the same (a span with the button's role, not a <button>,
/// whose text a browser leaves out of what is selected and copied). The
/// conversation listens for every one at once (`data-mention-ref`) — a
/// click, or Enter or Space on it — not with one handler each.
export type MentionLook = string | { className: string; ref?: string | null }

/// Slack's formatting, read back: *bold*, _italic_, ~strike~, `code`,
/// ```blocks```, "> " quotes, "- " and "1. " lists — plus links and @names.
export function renderRich(text: string, mentionClass: (name: string) => MentionLook): React.ReactNode {
  const out: React.ReactNode[] = []
  const parts = text.split(/```/)
  parts.forEach((chunk, ci) => {
    if (ci % 2 === 1) {
      out.push(<pre key={`pre-${ci}`} className="slk-pre"><code>{chunk.replace(/^\n/, '')}</code></pre>)
      return
    }
    const lines = chunk.split('\n')
    let list: React.ReactNode[] = []
    let ordered = false
    let quote: React.ReactNode[] = []
    // A list or a quote ends its own line: the line after it needs no break
    // of its own, or a blank line after a list reads as two.
    let afterBlock = false
    const flushList = (k: string) => {
      if (!list.length) return
      out.push(ordered ? <ol key={`ol-${k}`} className="slk-ol">{list}</ol> : <ul key={`ul-${k}`} className="slk-ul">{list}</ul>)
      list = []; afterBlock = true
    }
    const flushQuote = (k: string) => {
      if (!quote.length) return
      out.push(<blockquote key={`q-${k}`} className="slk-quote">{quote}</blockquote>)
      quote = []; afterBlock = true
    }
    const flush = (k: string) => { flushList(k); flushQuote(k) }
    lines.forEach((line, li) => {
      const key = `${ci}-${li}`
      // Quoted lines, one after another, are one quote.
      const q = /^(?:>|&gt;)\s?(.*)$/.exec(line)
      if (q) {
        flushList(key)
        if (quote.length) quote.push(<br key={`qbr-${key}`} />)
        quote.push(<React.Fragment key={key}>{inline(q[1], mentionClass)}</React.Fragment>)
        return
      }
      flushQuote(key)
      // Discord's headings ("# ", "## ", "### ") and subtext ("-# "): a line
      // of their own, so they end whatever list was open.
      const heading = /^(#{1,3})\s+(\S.*)$/.exec(line)
      const subtext = /^-#\s+(\S.*)$/.exec(line)
      if (heading || subtext) {
        flushList(key)
        out.push(heading
          ? <div key={key} className={`slk-h slk-h${heading[1].length}`} role="heading" aria-level={heading[1].length + 2}>{inline(heading[2], mentionClass)}</div>
          : <div key={key} className="slk-subtext">{inline(subtext![1], mentionClass)}</div>)
        afterBlock = true
        return
      }
      const bullet = /^\s*[-•*]\s+(.*)$/.exec(line)
      const number = /^\s*(\d+)[.)]\s+(.*)$/.exec(line)
      if (bullet && !/^\*[^*]+\*/.test(line.trim())) {
        if (list.length && ordered) flushList(key)
        ordered = false
        list.push(<li key={key}>{inline(bullet[1], mentionClass)}</li>); return
      }
      if (number) {
        if (list.length && !ordered) flushList(key)
        ordered = true
        list.push(<li key={key} value={Number(number[1])}>{inline(number[2], mentionClass)}</li>); return
      }
      flushList(key)
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

/// Discord's ||spoiler||: hidden under a bar until clicked (or Enter/Space),
/// then it stays shown. Screen readers are told it is hidden, not the text.
const Spoiler: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const t = useT()
  const [shown, setShown] = useState(false)
  if (shown) return <span className="slk-spoiler shown">{children}</span>
  const reveal = (e: React.SyntheticEvent) => { e.preventDefault(); e.stopPropagation(); setShown(true) }
  return (
    <span className="slk-spoiler" role="button" tabIndex={0} aria-label={t('Spoiler, press to reveal')}
      onClick={reveal} onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') reveal(e) }}>
      <span aria-hidden="true">{children}</span>
    </span>
  )
}

const JAM_AUDIO = /^https?:\/\/[^\s]+\/channels\/jam\/audio\/[0-9a-f-]{36}$/

/// `nested`: the words inside a *bold* or an _italic_, which are never a
/// line of their own however few emoji they are.
function inline(line: string, mentionClass: (name: string) => MentionLook, nested = false): React.ReactNode[] {
  // Doubled marks (Discord's ||spoiler||, __underline__, ~~strike~~) come
  // before their single forms so "__a__" is not read as "_" + "_a_" + "_".
  const tokens = line.split(/(`[^`\n]+`|https?:\/\/[^\s<>"）」|]+|:[a-z0-9_+-]{1,30}:|[@＠][^\s@＠,，。、!?！？:;|]+|\|\|[^|\n]+\|\||\*\*[^*\n]+\*\*|\*[^*\n]+\*|__[^_\n]+__|_[^_\n]+_|~~[^~\n]+~~|~[^~\n]+~)/g)
  // A line that is nothing but emoji — characters, or this workspace's own
  // — draws them large.
  const onlyEmoji = !nested && isEmojiOnly(line, (token) => Boolean(customEmojiUrl(token)))
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
    if (/^[@＠]/.test(part)) {
      const look = mentionClass(part)
      const { className, ref } = typeof look === 'string' ? { className: look, ref: null } : look
      return ref
        ? <span key={i} role="button" tabIndex={0} className={`${className} link`} data-mention-ref={ref} aria-haspopup="dialog">{part}</span>
        : <span key={i} className={className}>{part}</span>
    }
    if (/^\|\|[^|]+\|\|$/.test(part)) return <Spoiler key={i}>{inline(part.slice(2, -2), mentionClass, true)}</Spoiler>
    if (/^\*\*[^*]+\*\*$/.test(part)) return <b key={i}>{inline(part.slice(2, -2), mentionClass, true)}</b>
    if (/^\*[^*]+\*$/.test(part)) return <b key={i}>{inline(part.slice(1, -1), mentionClass, true)}</b>
    if (/^__[^_]+__$/.test(part)) return <u key={i}>{inline(part.slice(2, -2), mentionClass, true)}</u>
    if (/^_[^_]+_$/.test(part)) return <i key={i}>{inline(part.slice(1, -1), mentionClass, true)}</i>
    if (/^~~[^~]+~~$/.test(part)) return <s key={i}>{inline(part.slice(2, -2), mentionClass, true)}</s>
    if (/^~[^~]+~$/.test(part)) return <s key={i}>{inline(part.slice(1, -1), mentionClass, true)}</s>
    if (onlyEmoji && part.trim()) return <span key={i} className="slk-emoji big">{part}</span>
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

/// "Aki is typing…" just above a box, in a row kept for it whether or not
/// anyone is typing: it comes and goes without moving anything and is never
/// on top of what was said. A screen reader hears it through a region of its
/// own, at most once every few seconds: who is typing changes far more often
/// than anyone wants it read out.
export const TypingLine: React.FC<{ names: string[] }> = ({ names }) => {
  useT()
  const line = typingLine(names)
  const [told, setTold] = useState<Announced>({ text: '', at: 0 })
  useEffect(() => {
    const next = announce(told, line, Date.now())
    if (next !== told) { setTold(next); return }
    if (!line || line === told.text) return
    // Too soon after the last thing said: said once the gap is over, if
    // it is still true then. A little past it: a timer can wake a
    // millisecond before Date.now() agrees the gap is over, and one that
    // changes nothing is not run again.
    const id = setTimeout(() => setTold((prev) => announce(prev, line, Date.now())), told.at + ANNOUNCE_GAP_MS - Date.now() + 50)
    return () => clearTimeout(id)
  }, [line, told])
  return (
    <div className="slk-typing-people" data-typing={line ? '1' : undefined}>
      {line && (
        <span className="slk-typing-now" aria-hidden="true">
          <span className="slk-dots"><i /><i /><i /></span>
          <span className="slk-typing-text">{line}</span>
        </span>
      )}
      <span className="sr-only" role="status" aria-live="polite" aria-atomic="true">{told.text}</span>
    </div>
  )
}

// ---- Link cards ----
//
// A link in a message unfurls, as in Slack: the page's title, a line of
// what it is and its picture; a YouTube video plays in place when its
// thumbnail is pressed. Read through the Worker (/channels/link-preview),
// once per link per page load.

export interface LinkCard {
  kind: 'page' | 'youtube' | 'tiktok' | 'x'
  title: string
  description?: string
  image?: string | null
  site?: string
  icon?: string | null
  videoId?: string
}

const cardCache = new Map<string, Promise<LinkCard | null>>()
const LINK_RE = /https?:\/\/[^\s<>"'）」]+/g

/// The links a message would unfurl: the first two, not the app's own
/// recordings, trailing punctuation off.
export function unfurlable(text: string): string[] {
  const out: string[] = []
  for (const raw of String(text || '').match(LINK_RE) || []) {
    const url = raw.replace(/[.,!?;:)\]]+$/, '')
    if (JAM_AUDIO.test(url) || out.includes(url)) continue
    out.push(url)
    if (out.length >= 2) break
  }
  return out
}

function loadCard(httpBase: string, orgId: string, token: string, url: string): Promise<LinkCard | null> {
  if (!cardCache.has(url)) {
    cardCache.set(url, fetch(`${httpBase}/channels/link-preview?orgId=${encodeURIComponent(orgId)}&url=${encodeURIComponent(url)}`, { headers: { 'x-session-token': token } })
      .then((r) => (r.ok ? r.json() : null)).then((d) => (d?.card as LinkCard) || null).catch(() => null))
  }
  return cardCache.get(url)!
}

const LinkCardView: React.FC<{ url: string; httpBase: string; orgId: string; token: string; onHide?: () => void }> = ({ url, httpBase, orgId, token, onHide }) => {
  const t = useT()
  const [card, setCard] = useState<LinkCard | null>(null)
  const [playing, setPlaying] = useState(false)
  const [imageOk, setImageOk] = useState(true)
  useEffect(() => {
    let live = true
    void loadCard(httpBase, orgId, token, url).then((c) => { if (live) setCard(c) })
    return () => { live = false }
  }, [httpBase, orgId, token, url])
  if (!card) return null
  const video = card.kind === 'youtube' && card.videoId
  return (
    <div className={`link-card ${card.kind}`} data-link-card={card.kind}>
      {onHide && <button type="button" className="link-card-hide" onClick={onHide} aria-label={t('Remove preview')} title={t('Remove preview')}>×</button>}
      <div className="link-card-site">
        {card.icon && <img className="link-card-icon" src={card.icon} alt="" width={14} height={14} onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none' }} />}
        <span>{card.site}</span>
      </div>
      <a className="link-card-title" href={url} target="_blank" rel="noopener noreferrer">{card.title}</a>
      {card.description && <div className="link-card-desc">{card.description}</div>}
      {video && playing ? (
        <div className="link-card-player">
          <iframe
            src={`https://www.youtube-nocookie.com/embed/${card.videoId}?autoplay=1&rel=0`}
            title={card.title}
            allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
            allowFullScreen
          />
        </div>
      ) : card.image && imageOk ? (
        video ? (
          <button type="button" className="link-card-thumb video" onClick={() => setPlaying(true)} aria-label={t('Play {title}', { title: card.title })}>
            <img src={card.image} alt="" loading="lazy" onError={() => setImageOk(false)} />
            <span className="link-card-play" aria-hidden="true" />
          </button>
        ) : (
          <a className="link-card-thumb" href={url} target="_blank" rel="noopener noreferrer" tabIndex={-1}>
            <img src={card.image} alt="" loading="lazy" onError={() => setImageOk(false)} />
          </a>
        )
      ) : null}
    </div>
  )
}

/// The cards for the links in one message.
/// `onHide`: the author's × — takes the cards off the message for everyone.
export const LinkCards: React.FC<{ text: string; httpBase: string; orgId: string; token: string; onHide?: () => void }> = ({ text, httpBase, orgId, token, onHide }) => {
  const urls = unfurlable(text)
  if (!urls.length) return null
  return <div className="link-cards">{urls.map((u) => <LinkCardView key={u} url={u} httpBase={httpBase} orgId={orgId} token={token} onHide={onHide} />)}</div>
}
