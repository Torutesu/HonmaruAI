import { describe, it, expect } from 'vitest'
import React from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { RowMenu, keepOnScreen, step, focusGoesBack } from './RowMenu'

// The sidebar's right-click menu: what it draws before anyone touches it.
describe('RowMenu', () => {
  const html = renderToStaticMarkup(
    <RowMenu at={{ x: 10, y: 20 }} label="#kitchen" onClose={() => {}} entries={[
      { kind: 'item', label: 'Star channel', icon: 'star', data: 'star' },
      { kind: 'item', label: 'Copy', submenu: [{ kind: 'item', label: 'Copy link' }], data: 'copy' },
      { kind: 'sep' },
      { kind: 'head', label: 'Notify you about…' },
      { kind: 'item', label: 'All new posts', checked: false },
      { kind: 'item', label: 'Just mentions', checked: true },
      { kind: 'item', label: 'Leave channel', danger: true },
    ]} />,
  )
  it('draws the items, a line, the heading and a tick on the choice that is on', () => {
    expect(html).toContain('data-row-menu="star"')
    expect(html).toContain('role="separator"')
    expect(html).toContain('Notify you about…')
    expect(html).toMatch(/aria-checked="true" class=" checked"[^>]*>.*Just mentions/)
    expect(html).toMatch(/aria-checked="false"[^>]*>.*All new posts/)
    expect(html).toContain('class="danger"')
  })
  it('keeps a submenu shut until it is opened, and says it has one', () => {
    expect(html).toContain('aria-haspopup="menu"')
    expect(html).not.toContain('Copy link')
  })
  it('names the menu itself, where a screen reader reads it', () => {
    expect(html).toMatch(/^<div class="row-menu"[^>]*><ul role="menu" aria-label="#kitchen"/)
  })
})

// A message's right-click menu: its quick reactions in a row along the top.
describe('a strip in a RowMenu', () => {
  const html = renderToStaticMarkup(
    <RowMenu at={{ x: 10, y: 20 }} label="Message actions" onClose={() => {}} entries={[
      { kind: 'strip', label: 'Add reaction', items: [
        { label: 'React with ✅', text: '✅', onSelect: () => {}, data: 'react:✅' },
        { label: 'React with 👀', text: '👀', onSelect: () => {}, data: 'react:👀' },
        { label: 'Add reaction', icon: 'smile', onSelect: () => {}, data: 'react-more' },
      ] },
      { kind: 'sep' },
      { kind: 'item', label: 'Reply in thread', data: 'reply' },
    ]} />,
  )
  it('is one named group of menu items, each named for a screen reader, above the rest', () => {
    expect(html).toMatch(/<li role="none" class="row-menu-strip"><div role="group" aria-label="Add reaction">/)
    expect(html).toMatch(/<button[^>]*role="menuitem" aria-label="React with ✅"[^>]*data-row-menu="react:✅"[^>]*>✅<\/button>/)
    expect(html).toMatch(/aria-label="Add reaction"[^>]*data-row-menu="react-more"[^>]*><svg/)
    expect(html.indexOf('row-menu-strip')).toBeLessThan(html.indexOf('Reply in thread'))
  })
})

// Where a menu (or the picker opened from one) goes on a 1000×700 window.
describe('a menu kept on screen', () => {
  const view = { width: 1000, height: 700 }
  const size = { width: 240, height: 300 }
  it('opens at the point when it fits there', () => {
    expect(keepOnScreen({ x: 100, y: 200 }, size, view)).toEqual({ left: 100, top: 200 })
  })
  it('moves in from the right and the bottom edge, clear of them', () => {
    expect(keepOnScreen({ x: 900, y: 650 }, size, view)).toEqual({ left: 756, top: 396 })
  })
  it('keeps its top and left on screen when it is bigger than the window', () => {
    expect(keepOnScreen({ x: 10, y: 10 }, { width: 1200, height: 900 }, view)).toEqual({ left: 4, top: 4 })
  })
})

// The arrow keys: ↑ and ↓ down the list, ← and → along a strip.
describe('a step through a menu', () => {
  it('goes to the next or the one before, round from one end to the other', () => {
    expect(step(1, 4, true)).toBe(2)
    expect(step(1, 4, false)).toBe(0)
    expect(step(3, 4, true)).toBe(0)
    expect(step(0, 4, false)).toBe(3)
  })
  it('starts at the first going forward and the last going back, from nowhere in it', () => {
    expect(step(-1, 4, true)).toBe(0)
    expect(step(-1, 4, false)).toBe(3)
  })
  it('stays where it is in a list of one, and goes nowhere in an empty one', () => {
    expect(step(0, 1, true)).toBe(0)
    expect(step(0, 1, false)).toBe(0)
    expect(step(-1, 0, true)).toBe(-1)
  })
})

// What has the focus as a menu shuts, and whether it goes back to the
// message (or the row) that had it when the menu opened.
describe('the focus when a menu shuts', () => {
  const message = { isConnected: true }
  const body = { name: 'body' }
  const item = { name: 'an item' }
  const menu = { contains: (n: object) => n === item }
  it('goes back when it fell to the body with the item picked, or is still in the menu', () => {
    expect(focusGoesBack(message, body, body, menu)).toBe(true)
    expect(focusGoesBack(message, item, body, menu)).toBe(true)
    expect(focusGoesBack(message, null, body, menu)).toBe(true)
  })
  it('stays where a pick put it: the box to edit in, a dialog', () => {
    expect(focusGoesBack(message, { name: 'the edit box' }, body, menu)).toBe(false)
  })
  it('goes nowhere when what had it has left the page', () => {
    expect(focusGoesBack({ isConnected: false }, body, body, menu)).toBe(false)
    expect(focusGoesBack(null, body, body, menu)).toBe(false)
  })
})

// The surrounding conversation can become unread while a menu is open.
// Its conditional items must not reuse the React node for a different action.
describe('a live row menu', () => {
  it('keeps action nodes and open submenus attached to their actions when unread items change', async () => {
    const { act, create } = await import('react-test-renderer')
    const { vi } = await import('vitest')
    const doc = { activeElement: null, body: {}, addEventListener: () => {}, removeEventListener: () => {} }
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 700, addEventListener: () => {}, removeEventListener: () => {} })
    const picked = vi.fn()
    const close = () => {}
    const entries = (unread: boolean, star = true, label = 'Star channel'): React.ComponentProps<typeof RowMenu>['entries'] => [
      ...(unread ? [{ kind: 'item' as const, label: 'Mark all as read', data: 'mark-all' }, { kind: 'sep' as const }] : []),
      { kind: 'item', label: 'Channel details', data: 'details' },
      { kind: 'item', label: 'Copy', data: 'copy', submenu: [{ kind: 'item', label: 'Copy link', data: 'copy-link' }] },
      ...(star ? [{ kind: 'item' as const, label, data: 'star', onSelect: picked }] : []),
      { kind: 'item', label: 'Move', data: 'move' },
    ]
    const render = (unread: boolean, star = true, label = 'Star channel') => <RowMenu at={{ x: 10, y: 10 }} label="Front desk" onClose={close} entries={entries(unread, star, label)} />
    let tree!: ReturnType<typeof create>
    try {
      act(() => { tree = create(render(false)) })
      const star = tree.root.findByProps({ 'data-row-menu': 'star' })
      act(() => { tree.root.findByProps({ 'data-row-menu': 'copy' }).props.onClick() })
      expect(tree.root.findByProps({ 'data-row-menu': 'copy' }).props['aria-expanded']).toBe(true)
      act(() => { tree.update(render(true)) })
      expect(tree.root.findByProps({ 'data-row-menu': 'star' })).toBe(star)
      expect(tree.root.findByProps({ 'data-row-menu': 'copy' }).props['aria-expanded']).toBe(true)
      act(() => { tree.update(render(false)) })
      expect(tree.root.findByProps({ 'data-row-menu': 'star' })).toBe(star)
      act(() => { star.props.onClick() })
      expect(picked).toHaveBeenCalledTimes(1)
      // An action that changes from Star to Unstar must not retain a press.
      act(() => { tree.update(render(false, true, 'Unstar channel')) })
      expect(tree.root.findByProps({ 'data-row-menu': 'star' })).not.toBe(star)
      act(() => { tree.update(render(false, false)) })
      expect(tree.root.findAllByProps({ 'data-row-menu': 'star' })).toHaveLength(0)
    } finally {
      if (tree) act(() => { tree.unmount() })
      vi.unstubAllGlobals()
    }
  })

  it('keeps same-named sections distinct and does not reopen a removed submenu', async () => {
    const { act, create } = await import('react-test-renderer')
    const { vi } = await import('vitest')
    vi.stubGlobal('document', { activeElement: null, body: {}, addEventListener: () => {}, removeEventListener: () => {} })
    vi.stubGlobal('window', { innerWidth: 1000, innerHeight: 700, addEventListener: () => {}, removeEventListener: () => {} })
    const chosen = vi.fn(), close = () => {}
    const render = (first: boolean, copy: boolean) => <RowMenu at={{ x: 10, y: 10 }} label="Sections" onClose={close} entries={[
      ...(first ? [{ kind: 'item' as const, label: 'Team', identity: 'section:a', data: 'move-to:Team', onSelect: () => chosen('a') }] : []),
      { kind: 'item', label: 'Team', identity: 'section:b', data: 'move-to:Team', onSelect: () => chosen('b') },
      ...(copy ? [{ kind: 'item' as const, label: 'Copy', data: 'copy', submenu: [{ kind: 'item' as const, label: 'Copy link' }] }] : []),
    ]} />
    let tree!: ReturnType<typeof create>
    try {
      act(() => { tree = create(render(true, true)) })
      const second = tree.root.findAllByProps({ 'data-row-menu': 'move-to:Team' })[1]
      act(() => { tree.root.findByProps({ 'data-row-menu': 'copy' }).props.onClick() })
      act(() => { tree.update(render(false, false)) })
      expect(tree.root.findByProps({ 'data-row-menu': 'move-to:Team' })).toBe(second)
      act(() => { second.props.onClick() })
      expect(chosen).toHaveBeenCalledWith('b')
      act(() => { tree.update(render(false, true)) })
      expect(tree.root.findByProps({ 'data-row-menu': 'copy' }).props['aria-expanded']).toBe(false)
    } finally {
      if (tree) act(() => { tree.unmount() })
      vi.unstubAllGlobals()
    }
  })

})
