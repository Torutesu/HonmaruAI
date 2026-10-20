import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { AgentTierSelect } from './AgentTierSelect'
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text === 'Max' ? '最大' : text }))
test('tier list navigates without saving, commits explicitly and closes before its parent on Escape', () => {
  const listeners = new Map<string, any>(), changed = vi.fn(), focus = vi.fn()
  const triggerNode = { focus, getBoundingClientRect: () => ({ top: 500, bottom: 570, left: 650, width: 440 }) }
  vi.stubGlobal('window', { innerHeight: 600, innerWidth: 900, addEventListener: (name: string, fn: any) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) })
  vi.stubGlobal('document', { addEventListener: (name: string, fn: any) => listeners.set(name, fn), removeEventListener: (name: string) => listeners.delete(name) })
  let tree!: ReturnType<typeof create>
  try {
    act(() => { tree = create(<AgentTierSelect value="standard" onChange={changed}/>, { createNodeMock: element => element.type === 'button' ? triggerNode : { contains: (node: unknown) => node === triggerNode } }) })
    const combo = () => tree.root.findByProps({ role: 'combobox' })
    const key = (key: string) => act(() => combo().props.onKeyDown({ key, preventDefault: vi.fn() }))
    act(() => combo().props.onClick())
    expect(tree.root.findByProps({ role: 'listbox' }).props.className).toContain('above')
    expect(tree.root.findByProps({ role: 'listbox' }).props.style).toMatchObject({ left: 448, top: 496, width: 440, transform: 'translateY(-100%)' })
    expect(tree.root.findAllByType('strong').map(item => item.children.join(''))).toContain('Max')
    key('ArrowDown')
    expect(changed).not.toHaveBeenCalled()
    key('Enter')
    expect(changed).toHaveBeenCalledWith('max')
    expect(combo().props['aria-expanded']).toBe(false)
    act(() => combo().props.onClick())
    const escape = { key: 'Escape', target: triggerNode, preventDefault: vi.fn(), stopImmediatePropagation: vi.fn() }
    act(() => listeners.get('keydown')(escape))
    expect(escape.stopImmediatePropagation).toHaveBeenCalledOnce()
    expect(combo().props['aria-expanded']).toBe(false)
    expect(focus).toHaveBeenCalled()
    act(() => combo().props.onClick())
    act(() => listeners.get('pointerdown')({ target: {} }))
    expect(combo().props['aria-expanded']).toBe(false)
    act(() => combo().props.onClick())
    act(() => listeners.get('resize')({ target: window }))
    expect(combo().props['aria-expanded']).toBe(false)
    act(() => tree.update(<AgentTierSelect value="standard" onChange={changed} disabled/>))
    act(() => combo().props.onClick())
    expect(combo().props['aria-expanded']).toBe(false)
    expect(changed).toHaveBeenCalledTimes(1)
  } finally { act(() => tree?.unmount()); vi.unstubAllGlobals() }
})
