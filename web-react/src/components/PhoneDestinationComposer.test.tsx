import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { PhoneDestinationComposer } from './PhoneDestinationComposer'

vi.mock('./Sheet', () => ({
  Sheet: ({ children, label }: any) => <section aria-label={label}>{children}</section>,
  SheetRow: ({ label, onClick }: any) => <button type="button" onClick={onClick}>{label}</button>,
}))

const destinations = [
  { key: 'room:planning', view: 'b:planning', name: 'Planning', kind: 'channel' },
  { key: 'dm:aya', view: 'dm:aya', name: 'Aya', kind: 'person' },
]
const api = { httpBase: 'https://honmaru.test', orgId: 'org-1', sessionToken: 'session-1' }
const render = (onChoose = vi.fn(), onClose = vi.fn(), places = destinations) => {
  let tree!: ReturnType<typeof create>
  act(() => { tree = create(<PhoneDestinationComposer destinations={places} api={api} onClose={onClose} onChoose={onChoose} t={(s) => s} />) })
  return tree
}
const typeDraft = (tree: ReturnType<typeof create>, value: string) => act(() => tree.root.findByType('textarea').props.onChange({ target: { value } }))

beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ messages: [] }) }))
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

test('suggests only supplied readable destinations and selection returns a draft without sending', () => {
  const choose = vi.fn()
  const close = vi.fn()
  const tree = render(choose, close)
  typeDraft(tree, 'Can you review this?')
  expect(tree.root.findByType('textarea').props['data-sheet-autofocus']).toBe('true')
  expect(tree.root.findByType('textarea').props['aria-describedby']).toBe('phone-draft-note')
  act(() => tree.root.findByType('input').props.onChange({ target: { value: 'plan' } }))
  expect(tree.root.findAllByType('button').map((button) => button.children.join(''))).toEqual(['×', 'Planning', 'Cancel'])
  act(() => tree.root.findAllByType('button')[1].props.onClick())
  expect(choose).toHaveBeenCalledWith(destinations[0], 'Can you review this?')
  expect(close).not.toHaveBeenCalled()
  act(() => tree.unmount())
})

test('empty draft can be selected and remains a draft-only callback', () => {
  const choose = vi.fn()
  const tree = render(choose)
  act(() => tree.root.findAllByType('button')[1].props.onClick())
  expect(choose).toHaveBeenCalledWith(destinations[0], '')
  act(() => tree.unmount())
})

test('shows an empty state when a search has no matching destination', () => {
  const tree = render(vi.fn(), vi.fn(), destinations)
  act(() => tree.root.findByType('input').props.onChange({ target: { value: 'missing' } }))
  expect(tree.root.findAllByType('button').map((button) => button.children.join(''))).toEqual(['×', 'Cancel'])
  expect(tree.root.findByProps({ role: 'status' }).children.join('')).toBe('No matching conversations or rooms')
  act(() => tree.unmount())
})

test('shows an empty state when there are no readable destinations', () => {
  const tree = render(vi.fn(), vi.fn(), [])
  expect(tree.root.findByProps({ role: 'status' }).children.join('')).toBe('No matching conversations or rooms')
  act(() => tree.unmount())
})

test('close and cancel both dismiss without choosing or sending', () => {
  for (const label of ['×', 'Cancel']) {
    const choose = vi.fn()
    const close = vi.fn()
    const tree = render(choose, close)
    const button = tree.root.findAllByType('button').find((item) => item.children.join('') === label)
    expect(button).toBeDefined()
    act(() => button!.props.onClick())
    expect(close).toHaveBeenCalledTimes(1)
    expect(choose).not.toHaveBeenCalled()
    act(() => tree.unmount())
  }
})

test('selects a relevant thread returned by the permission-checked server search', async () => {
  const fetchMock = vi.mocked(fetch)
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ messages: [{ id: 'reply-1', channel: 'b:planning', parentId: 'root-1', replyCount: 2, body: 'release planning review' }] }),
  } as Response)
  const choose = vi.fn()
  const tree = render(choose)
  typeDraft(tree, 'release planning review')
  await act(async () => { await vi.advanceTimersByTimeAsync(260) })
  const option = tree.root.findAllByType('button').find((item) => item.children.join('').includes('Planning · release planning review'))
  expect(option).toBeDefined()
  act(() => option!.props.onClick())
  expect(choose).toHaveBeenCalledWith(expect.objectContaining({ key: 'room:planning', threadId: 'root-1' }), 'release planning review')
  expect(fetchMock).toHaveBeenCalledTimes(3)
  expect(fetchMock.mock.calls.every((call) => String(call[0]).includes('/channels/search'))).toBe(true)
  act(() => tree.unmount())
})

test('does not surface any destination from a denied server search', async () => {
  const fetchMock = vi.mocked(fetch)
  fetchMock.mockResolvedValueOnce({
    ok: false,
    status: 403,
    json: async () => ({ messages: [{ id: 'private-1', channel: 'b:private', body: 'secret launch', replyCount: 2 }] }),
  } as Response)
  const tree = render(vi.fn(), vi.fn(), destinations)
  typeDraft(tree, 'secret launch')
  await act(async () => { await vi.advanceTimersByTimeAsync(260) })
  expect(tree.root.findAllByType('button').map((button) => button.children.join(''))).not.toContain('Private')
  expect(tree.root.findAllByType('button').some((button) => button.children.join('').includes('private'))).toBe(false)
  act(() => tree.unmount())
})
