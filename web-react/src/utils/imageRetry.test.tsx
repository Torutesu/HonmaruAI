import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Avatar } from '../components/Avatar'
import { WorkspaceMark } from '../components/WorkspaceSwitcher'
import { renderRich } from '../components/MessageParts'
import { Lightbox } from '../components/Attachments'
import { loadCustomEmoji } from './customEmoji'
import type { FileRef } from '../types/card'

vi.mock('../utils/i18n', () => ({ useT: () => (s: string) => s }))
vi.mock('react-dom', async (actual) => ({ ...(await actual<typeof import('react-dom')>()), createPortal: (node: React.ReactNode) => node }))

// Pictures that would not load (#824): what is drawn instead, and when the
// picture is tried again.

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals() })
const imgs = (tree: ReactTestRenderer) => tree.root.findAllByType('img')
const fail = (tree: ReactTestRenderer) => act(() => imgs(tree)[0].props.onError())

describe('a face', () => {
  it('tries a new address after the last one failed', () => {
    let tree!: ReactTestRenderer
    act(() => { tree = create(<Avatar name="Alice" url="https://images.test/old.png" />) })
    fail(tree)
    expect(imgs(tree)).toHaveLength(0)
    expect(tree.root.findByType('span').props.className).toBe('avatar-initial')
    act(() => tree.update(<Avatar name="Alice" url="https://images.test/restored.png" />))
    expect(imgs(tree).map((i) => i.props.src)).toEqual(['https://images.test/restored.png'])
    act(() => tree.unmount())
  })

  it('tries the same address again later, twice, and when back online, never in a loop', () => {
    vi.useFakeTimers()
    const listeners = new Map<string, () => void>()
    vi.stubGlobal('window', { addEventListener: (type: string, fn: () => void) => listeners.set(type, fn), removeEventListener: (type: string) => listeners.delete(type) })
    let tree!: ReactTestRenderer
    act(() => { tree = create(<Avatar name="Alice" url="https://images.test/a.png" />) })
    fail(tree)
    act(() => { vi.advanceTimersByTime(15_000) })
    expect(imgs(tree)).toHaveLength(1)
    fail(tree)
    act(() => { vi.advanceTimersByTime(60_000) })
    expect(imgs(tree)).toHaveLength(1)
    fail(tree)
    act(() => { vi.advanceTimersByTime(10 * 60_000) })
    expect(imgs(tree)).toHaveLength(0)
    act(() => listeners.get('online')!())
    expect(imgs(tree)).toHaveLength(1)
    act(() => tree.unmount())
  })
})

describe('a workspace logo', () => {
  it('shows the letter when it will not load, and a new logo when one is set', () => {
    let tree!: ReactTestRenderer
    const at = (icon: string) => <WorkspaceMark workspace={{ id: 'a', name: 'Alpha', role: 'member', icon }} label="Alpha" />
    act(() => { tree = create(at('https://images.test/missing.png')) })
    fail(tree)
    expect(imgs(tree)).toHaveLength(0)
    expect(tree.root.findByType('span').children).toEqual(['A'])
    act(() => tree.update(at('https://images.test/new.png')))
    expect(imgs(tree).map((i) => i.props.src)).toEqual(['https://images.test/new.png'])
    act(() => tree.unmount())
  })
})

describe('an emoji in a message', () => {
  it('recovers as a reaction does: still missing once the list is read again, it is drawn as its name', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ emoji: [{ name: 'party', url: 'https://images.test/missing.svg', by: null, createdAt: '' }] }))))
    await loadCustomEmoji('https://images.test', 'token', 'audit-824')
    const Body = () => <>{renderRich(':party: time', () => 'm')}</>
    let tree!: ReactTestRenderer
    act(() => { tree = create(<Body />) })
    expect(imgs(tree)).toHaveLength(1)
    await act(async () => { await imgs(tree)[0].props.onError() })
    act(() => tree.update(<Body />))
    expect(imgs(tree)).toHaveLength(0)
    expect(JSON.stringify(tree.toJSON())).toContain(':party:')
    act(() => tree.unmount())
  })
})

describe('a picture opened full size', () => {
  const photo: FileRef = { id: 'f_000000000000000000000001', name: 'photo.png', type: 'image/png', size: 10, url: '/files/f1' }
  it('asks for a new address when it will not open, says so meanwhile, and can be tried again', () => {
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    const stale = vi.fn()
    let tree!: ReactTestRenderer
    act(() => { tree = create(<Lightbox files={[photo]} at={0} src={() => 'https://api.test/files/f1'} onStale={stale} onMove={vi.fn()} onClose={vi.fn()} />) })
    fail(tree)
    expect(stale).toHaveBeenCalledWith(photo)
    expect(imgs(tree)).toHaveLength(0)
    expect(tree.root.findByProps({ role: 'status' })).toBeTruthy()
    act(() => tree.root.findByProps({ className: 'btn' }).props.onClick())
    expect(stale).toHaveBeenCalledTimes(2)
    expect(imgs(tree)).toHaveLength(1)
    act(() => tree.unmount())
  })

  it('shows the renewed address as soon as it comes', () => {
    vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn() })
    let address = 'https://api.test/files/f1?e=1'
    const view = () => <Lightbox files={[photo]} at={0} src={() => address} onStale={vi.fn()} onMove={vi.fn()} onClose={vi.fn()} />
    let tree!: ReactTestRenderer
    act(() => { tree = create(view()) })
    fail(tree)
    expect(imgs(tree)).toHaveLength(0)
    address = 'https://api.test/files/f1?e=2'
    act(() => tree.update(view()))
    expect(imgs(tree).map((i) => i.props.src)).toEqual([address])
    act(() => tree.unmount())
  })
})
