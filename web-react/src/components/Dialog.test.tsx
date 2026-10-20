import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { Dialog } from './Dialog'
vi.mock('react-dom', () => ({ createPortal: (children: any) => children }))
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
vi.mock('./Icon', () => ({ Icon: () => null }))
test('dialog traps Tab, skips hidden controls, closes only the top dialog and uses the latest handler', () => {
  const listeners = new Map<string, (event: any) => void>()
  const previous = { focus: vi.fn() }
  const doc: any = { activeElement: previous, body: {}, addEventListener: (key: string, cb: any) => listeners.set(key, cb), removeEventListener: (key: string) => listeners.delete(key), querySelectorAll: () => [box] }
  const element = (hidden = false, isClose = false): any => {
    const item: any = { tabIndex: 0, matches: () => hidden, getClientRects: () => hidden ? [] : [{}], classList: { contains: () => isClose }, focus: () => { doc.activeElement = item } }
    return item
  }
  const closeButton = element(false, true), file = element(true), first = element(), last = element()
  const box: any = { querySelectorAll: () => [closeButton, file, first, last], focus: vi.fn() }
  const oldClose = vi.fn(), newClose = vi.fn()
  vi.stubGlobal('document', doc)
  let tree!: ReturnType<typeof create>
  const key = (value: string, extra = {}) => {
    const event = { key: value, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn(), ...extra }
    listeners.get('keydown')!(event); return event
  }
  try {
    act(() => { tree = create(<Dialog title="Profile" onClose={oldClose}><input/></Dialog>, { createNodeMock: el => el.props.role === 'dialog' ? box : null }) })
    expect(doc.activeElement).toBe(first)
    doc.activeElement = last; key('Tab'); expect(doc.activeElement).toBe(closeButton)
    key('Tab', { shiftKey: true }); expect(doc.activeElement).toBe(last)
    doc.activeElement = closeButton; key('Tab'); expect(doc.activeElement).toBe(first)
    doc.querySelectorAll = () => [box, {}]
    key('Escape'); expect(oldClose).not.toHaveBeenCalled()
    doc.querySelectorAll = () => [box]
    act(() => tree.update(<Dialog title="Profile" onClose={newClose}><input/></Dialog>))
    key('Escape', { isComposing: true }); expect(newClose).not.toHaveBeenCalled()
    const event = key('Escape')
    expect(newClose).toHaveBeenCalledOnce(); expect(oldClose).not.toHaveBeenCalled()
    expect(event.preventDefault).toHaveBeenCalledOnce()
    act(() => tree.unmount()); expect(previous.focus).toHaveBeenCalledOnce()
  } finally { vi.unstubAllGlobals() }
})
