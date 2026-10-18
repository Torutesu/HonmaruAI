import { describe, it, expect, vi, afterEach } from 'vitest'
import type { MenuEntry } from '../components/RowMenu'
import { messageMenuEntries, messageContextEntries, opensMessageMenu, isMenuKey, messageMenuTriggers, NATIVE_MENU_SPOT, type MessageMenuActions } from './messageMenu'

// English, as the keys are; the words filled in as `t` would.
const t = (english: string, vars?: Record<string, string | number>) => english.replace(/\{(\w+)\}/g, (_, k: string) => String(vars?.[k] ?? ''))
const noop = () => {}

/// Everything a reader may do to a teammate's message in a channel, as the
/// conversation hands it over.
const teammates: MessageMenuActions = {
  onReply: noop, onPin: noop, onDecide: noop, onLater: noop, onClip: noop, onUnread: noop, onForward: noop, onCopyLink: noop,
}
const shape = (list: MenuEntry[]) => list.map((e) => (e.kind === 'item' ? e.data : e.kind === 'sep' ? '—' : e.kind))
const item = (list: MenuEntry[], data: string) => list.find((e): e is Extract<MenuEntry, { kind: 'item' }> => e.kind === 'item' && e.data === data)

describe('what can be done to a message', () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })

  it('offers a teammate’s message everything but editing and deleting it, in groups', () => {
    const list = messageMenuEntries({ body: 'hi', pinned: false }, { ...teammates, t })
    expect(shape(list)).toEqual([
      'reply', 'decide', 'pin', 'clip', 'unread', 'forward', 'link', '—',
      'later', 'remind-hour', 'remind-tomorrow', '—',
      'copy',
    ])
  })

  it('puts editing your own first and deleting it last, apart and in red', () => {
    const list = messageMenuEntries({ body: 'mine', pinned: false }, { ...teammates, onUnread: undefined, onEdit: noop, onDelete: noop, t })
    expect(shape(list)[0]).toBe('edit')
    expect(shape(list).slice(-2)).toEqual(['—', 'delete'])
    expect(item(list, 'delete')).toMatchObject({ label: 'Delete message', danger: true, icon: 'trash' })
    expect(item(list, 'unread')).toBeUndefined()
  })

  it('has no thread to reply in and nothing to pin inside a thread', () => {
    const list = messageMenuEntries({ body: 'a reply', pinned: false }, { ...teammates, inThread: true, t })
    expect(item(list, 'reply')).toBeUndefined()
    expect(item(list, 'pin')).toBeUndefined()
    expect(item(list, 'forward')).toBeDefined()
  })

  it('answers one reply inside a thread, quoted, where a reply is offered', () => {
    const list = messageMenuEntries({ body: 'a reply', pinned: false }, { ...teammates, inThread: true, onQuote: noop, t })
    expect(item(list, 'quote')?.label).toBe('Reply')
    expect(item(list, 'reply')).toBeUndefined()
  })

  it('says what a second press would do: unpin a pinned one, take a clipped one out', () => {
    const list = messageMenuEntries({ body: 'x', pinned: true }, { ...teammates, clipped: true, t })
    expect(item(list, 'pin')?.label).toBe('Unpin')
    expect(item(list, 'clip')?.label).toBe('Remove from clip')
    const fresh = messageMenuEntries({ body: 'x', pinned: false }, { ...teammates, t })
    expect(item(fresh, 'pin')?.label).toBe('Pin to channel')
    expect(item(fresh, 'clip')?.label).toBe('Add to clip')
  })

  it('leaves no line at either end, nor two together, when a group is empty', () => {
    // A file with no words, yours, with nothing to save it for.
    const list = messageMenuEntries({ body: '', pinned: false }, { onEdit: noop, onDelete: noop, t })
    expect(shape(list)).toEqual(['edit', '—', 'delete'])
    expect(messageMenuEntries({ body: '', pinned: false }, { t })).toEqual([])
  })

  it('has an icon for every item, which is all a phone’s sheet draws beside it', () => {
    const list = messageMenuEntries({ body: 'x', pinned: false }, { ...teammates, onEdit: noop, onDelete: noop, t })
    for (const e of list) if (e.kind === 'item') expect(e.icon, e.data).toBeTruthy()
  })

  it('names the key a picked message answers to beside what it does, and no other', () => {
    const list = messageMenuEntries({ body: 'x', pinned: false }, { ...teammates, onQuote: noop, onEdit: noop, onDelete: noop, t })
    const hints = Object.fromEntries(list.filter((e): e is Extract<MenuEntry, { kind: 'item' }> => e.kind === 'item').map((e) => [e.data, e.hint]))
    expect(hints).toMatchObject({ edit: 'E', reply: 'T', pin: 'P', delete: '⌫' })
    expect(hints.quote).toBeUndefined()
    expect(hints.later).toBeUndefined()
  })

  it('offers an inline reply where the conversation does, never in a thread', () => {
    expect(item(messageMenuEntries({ body: 'x', pinned: false }, { ...teammates, onQuote: noop, t }), 'quote')?.label).toBe('Reply')
    expect(item(messageMenuEntries({ body: 'x', pinned: false }, { ...teammates, t }), 'quote')).toBeUndefined()
  })

  it('does what it says when picked, taking the time for a reminder when it is picked', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 8, 30, 14, 0, 0))
    const later = vi.fn()
    const reply = vi.fn()
    const list = messageMenuEntries({ body: 'x', pinned: false }, { ...teammates, onReply: reply, onLater: later, t })
    item(list, 'reply')?.onSelect?.()
    expect(reply).toHaveBeenCalledOnce()
    item(list, 'later')?.onSelect?.()
    expect(later).toHaveBeenLastCalledWith(null)
    vi.setSystemTime(new Date(2026, 8, 30, 15, 0, 0))
    item(list, 'remind-hour')?.onSelect?.()
    expect(later).toHaveBeenLastCalledWith(new Date(2026, 8, 30, 16, 0, 0).toISOString())
    item(list, 'remind-tomorrow')?.onSelect?.()
    expect(later).toHaveBeenLastCalledWith(new Date(2026, 9, 1, 9, 0, 0).toISOString())
  })

  it('copies the message’s own words', () => {
    const writeText = vi.fn(() => Promise.resolve())
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    item(messageMenuEntries({ body: 'the words', pinned: false }, { t }), 'copy')?.onSelect?.()
    expect(writeText).toHaveBeenCalledWith('the words')
  })
})

describe('a right-click on a message', () => {
  it('has the quick reactions in a row along the top, the picker last, then the same list as ⋯', () => {
    const onReact = vi.fn()
    const more = vi.fn()
    const list = messageContextEntries({ body: 'hi', pinned: false }, { ...teammates, t, reactions: ['✅', '👀', '🙌'], onReact, onMoreReactions: more })
    const [strip, line, ...rest] = list
    expect(line).toEqual({ kind: 'sep' })
    expect(shape(rest)).toEqual(shape(messageMenuEntries({ body: 'hi', pinned: false }, { ...teammates, t })))
    if (strip.kind !== 'strip') throw new Error('no strip first')
    expect(strip.label).toBe('Add reaction')
    expect(strip.items.map((i) => i.text ?? i.icon)).toEqual(['✅', '👀', '🙌', 'smile'])
    expect(strip.items[1].label).toBe('React with 👀')
    strip.items[1].onSelect()
    expect(onReact).toHaveBeenCalledWith('👀')
    strip.items[3].onSelect()
    expect(more).toHaveBeenCalledOnce()
  })

  it('is just the reactions when there is nothing else to offer', () => {
    const list = messageContextEntries({ body: '', pinned: false }, { t, reactions: ['✅'], onReact: noop })
    expect(shape(list)).toEqual(['strip'])
  })

  it('opens the message’s menu, but leaves the browser’s to Shift, a link or a picture, and selected words', () => {
    expect(opensMessageMenu({ shiftKey: false, overNative: false, selected: '' })).toBe(true)
    expect(opensMessageMenu({ shiftKey: true, overNative: false, selected: '' })).toBe(false)
    expect(opensMessageMenu({ shiftKey: false, overNative: true, selected: '' })).toBe(false)
    expect(opensMessageMenu({ shiftKey: false, overNative: false, selected: 'some words' })).toBe(false)
    // A click that only put the caret somewhere selected nothing.
    expect(opensMessageMenu({ shiftKey: false, overNative: false, selected: ' \n' })).toBe(true)
  })

  it('leaves the browser’s menu to an attached picture, not to a face or an emoji drawn as one', () => {
    const spots = NATIVE_MENU_SPOT.split(', ')
    expect(spots).toContain('.att-pic img')
    expect(spots).toEqual(expect.arrayContaining(['a[href]', 'video', 'audio', 'iframe', 'canvas']))
    expect(spots).not.toContain('img')
  })
})

describe('the keyboard’s way to the menu', () => {
  const key = (k: string, mods: Partial<{ shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }> = {}) =>
    ({ key: k, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, ...mods })
  it('is the menu key or Shift+F10', () => {
    expect(isMenuKey(key('ContextMenu'))).toBe(true)
    expect(isMenuKey(key('F10', { shiftKey: true }))).toBe(true)
  })
  it('is not F10 alone, nor either with another modifier, nor Shift with the menu key', () => {
    expect(isMenuKey(key('F10'))).toBe(false)
    expect(isMenuKey(key('F10', { shiftKey: true, ctrlKey: true }))).toBe(false)
    expect(isMenuKey(key('ContextMenu', { altKey: true }))).toBe(false)
    expect(isMenuKey(key('ContextMenu', { shiftKey: true }))).toBe(false)
    expect(isMenuKey(key('e'))).toBe(false)
  })
})

// A message on the page, as far as its triggers touch it: its own element,
// the words in it, a link in it, and whatever is selected — which a test
// changes as a browser would, a range being what was selected when taken.
function page({ selected = '', inMessage = true } = {}) {
  const link = { closest: (s: string) => (s === NATIVE_MENU_SPOT ? link : null) }
  const words = { closest: () => null }
  const article = {
    id: 'msg-m1',
    contains: (n: unknown): boolean => n === article || n === link || n === words,
    querySelector: (s: string) => (s === '.slk-body' ? { getBoundingClientRect: () => ({ left: 120, top: 300, bottom: 360 }) } : null),
    getBoundingClientRect: () => ({ left: 60, top: 300, bottom: 360 }),
  }
  const sel = {
    text: selected,
    get isCollapsed(): boolean { return !sel.text },
    rangeCount: 1,
    toString: (): string => sel.text,
    containsNode: (n: unknown) => inMessage && n === article,
    getRangeAt: () => ({ cloneRange: (): { text: string } => ({ text: sel.text }) }),
    removeAllRanges: (): void => { sel.text = '' },
    addRange: (r: { text: string }): void => { sel.text = r.text },
  }
  vi.stubGlobal('window', { getSelection: () => sel })
  return { article, link, words, sel }
}
/// An event on the message, the way React hands one over.
function event(article: unknown, target: unknown, more: Record<string, unknown> = {}) {
  let prevented = false
  const e = { currentTarget: article, target, button: 0, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false, clientX: 400, clientY: 320, key: '', preventDefault: () => { prevented = true }, ...more }
  return { e: e as never, prevented: () => prevented }
}

describe('a laptop’s ways into a message’s menu', () => {
  afterEach(() => { vi.unstubAllGlobals() })

  it('opens where the pointer is on a right-click, and keeps the browser’s menu away', () => {
    const { article, words } = page()
    const open = vi.fn()
    const { e, prevented } = event(article, words)
    messageMenuTriggers(open).onContextMenu!(e)
    expect(open).toHaveBeenCalledWith({ x: 400, y: 320 }, 'msg-m1')
    expect(prevented()).toBe(true)
  })

  it('leaves the browser’s menu to a link, to Shift, and to words of it selected', () => {
    const open = vi.fn()
    const onLink = page()
    const a = event(onLink.article, onLink.link)
    messageMenuTriggers(open).onContextMenu!(a.e)
    const shifted = event(onLink.article, onLink.words, { shiftKey: true })
    messageMenuTriggers(open).onContextMenu!(shifted.e)
    const chosen = page({ selected: 'to copy' })
    const s = event(chosen.article, chosen.words)
    messageMenuTriggers(open).onContextMenu!(s.e)
    expect(open).not.toHaveBeenCalled()
    expect([a.prevented(), shifted.prevented(), s.prevented()]).toEqual([false, false, false])
  })

  it('leaves alone what the message draws outside itself, a picture opened over the page', () => {
    // A portal's events reach the message through React, but its element
    // does not hold them.
    const { article } = page()
    const viewer = { closest: () => null }
    const open = vi.fn()
    const click = event(article, viewer)
    messageMenuTriggers(open).onContextMenu!(click.e)
    const key = event(article, viewer, { key: 'ContextMenu' })
    messageMenuTriggers(open).onKeyDown!(key.e)
    expect(open).not.toHaveBeenCalled()
    expect([click.prevented(), key.prevented()]).toEqual([false, false])
  })

  it('goes by what was selected when the button went down, not the word a Mac selects on the way', () => {
    // Nothing selected; a right-click (or a Ctrl+click) goes down on the
    // words, the browser selects the word under it, then asks for a menu.
    for (const press of [{ button: 2 }, { button: 0, ctrlKey: true }]) {
      const { article, words, sel } = page()
      const open = vi.fn()
      const triggers = messageMenuTriggers(open)
      triggers.onMouseDownCapture!(event(article, words, press).e)
      sel.text = 'Check-in'
      const click = event(article, words, press)
      triggers.onContextMenu!(click.e)
      expect(open, JSON.stringify(press)).toHaveBeenCalledOnce()
      expect(click.prevented()).toBe(true)
      // The word the browser lit is put back as it was: nothing selected.
      expect(sel.text).toBe('')
    }
  })

  it('leaves the browser’s menu to words that were selected when the button went down', () => {
    const { article, words, sel } = page({ selected: 'to copy' })
    const open = vi.fn()
    const triggers = messageMenuTriggers(open)
    triggers.onMouseDownCapture!(event(article, words, { button: 2 }).e)
    const click = event(article, words)
    triggers.onContextMenu!(click.e)
    expect(open).not.toHaveBeenCalled()
    expect(click.prevented()).toBe(false)
    expect(sel.text).toBe('to copy')
  })

  it('still opens when what is selected is somewhere else', () => {
    const { article, words } = page({ selected: 'elsewhere', inMessage: false })
    const open = vi.fn()
    messageMenuTriggers(open).onContextMenu!(event(article, words).e)
    expect(open).toHaveBeenCalledOnce()
  })

  it('opens from Shift+F10 or the menu key under the message’s first line, and from no other key', () => {
    const { article } = page()
    const open = vi.fn()
    const f10 = event(article, article, { key: 'F10', shiftKey: true })
    messageMenuTriggers(open).onKeyDown!(f10.e)
    expect(open).toHaveBeenLastCalledWith({ x: 120, y: 324 }, 'msg-m1')
    expect(f10.prevented()).toBe(true)
    messageMenuTriggers(open).onKeyDown!(event(article, article, { key: 'ContextMenu' }).e)
    expect(open).toHaveBeenCalledTimes(2)
    const plain = event(article, article, { key: 'Enter' })
    messageMenuTriggers(open).onKeyDown!(plain.e)
    expect(open).toHaveBeenCalledTimes(2)
    expect(plain.prevented()).toBe(false)
  })

  it('adds nothing to a message that has no menu (one deleted, or being edited)', () => {
    expect(messageMenuTriggers(undefined)).toEqual({})
  })
})
