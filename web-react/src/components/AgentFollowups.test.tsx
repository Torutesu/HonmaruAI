import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { AgentFollowups } from './AgentFollowups'
vi.mock('../utils/i18n', () => ({ useT: () => (key: string) => key }))
let tree: ReturnType<typeof create>
afterEach(() => { if (tree) act(() => tree.unmount()) })
const item = { id: 'one', agentId: 'agent', channel: 'b:ops', instruction: 'Check invoice', status: 'failed', dueAt: '2026-10-23T00:00:00Z', result: '<script>failed</script>' }
test('status selection loads failure history as inert text and offers no cancellation', async () => {
 const api = { followupHistory: vi.fn().mockResolvedValue({ followups: [] }), cancelFollowup: vi.fn() }
 await act(async () => { tree = create(<AgentFollowups api={api as any} agentId="agent" />) })
 api.followupHistory.mockResolvedValue({ followups: [item, { ...item, id: 'other', agentId: 'other' }] })
 await act(async () => { tree.root.findByType('select').props.onChange({ target: { value: 'failed' } }) })
 expect(api.followupHistory).toHaveBeenLastCalledWith('agent', 'failed')
 expect(tree.root.findAllByType('details')).toHaveLength(1)
 expect(tree.root.findByType('pre').children).toEqual([item.result])
 expect(tree.root.findAllByType('script')).toHaveLength(0)
 expect(tree.root.findAllByType('button').some(b => b.children.includes('Cancel'))).toBe(false)
 expect(api.cancelFollowup).not.toHaveBeenCalled()
})
test('a delayed old status response cannot replace the latest history', async () => {
 let resolve: (value: any) => void = () => {}
 const api = { followupHistory: vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r })).mockResolvedValue({ followups: [item] }), cancelFollowup: vi.fn() }
 await act(async () => { tree = create(<AgentFollowups api={api as any} agentId="agent" />) })
 await act(async () => { tree.root.findByType('select').props.onChange({ target: { value: 'failed' } }) })
 await act(async () => { resolve({ followups: [{ ...item, instruction: 'Stale scheduled item', status: 'scheduled' }] }) })
 expect(JSON.stringify(tree.toJSON())).not.toContain('Stale scheduled item')
 expect(tree.root.findByType('pre').children).toEqual([item.result])
})

test('cancellation failures preserve the scheduled item and refresh does not cancel it', async () => {
 const scheduled = { ...item, status: 'scheduled', result: null }
 const api = { followupHistory: vi.fn().mockResolvedValue({ followups: [scheduled] }), cancelFollowup: vi.fn().mockRejectedValueOnce(new Error('Could not cancel')).mockResolvedValue({ cancelled: true }) }
 await act(async () => { tree = create(<AgentFollowups api={api as any} agentId="agent" />) })
 const button = (name: string) => tree.root.findAllByType('button').find(b => b.children.includes(name))!
 await act(async () => { await button('Cancel').props.onClick() })
 expect(tree.root.findByProps({ role: 'alert' }).children).toContain('Could not cancel')
 expect(button('Cancel')).toBeTruthy()
 await act(async () => { button('Refresh').props.onClick() })
 expect(api.cancelFollowup).toHaveBeenCalledTimes(1)
 api.followupHistory.mockResolvedValue({ followups: [] })
 await act(async () => { await button('Cancel').props.onClick() })
 expect(api.cancelFollowup).toHaveBeenLastCalledWith('one')
 expect(button('Cancel')).toBeUndefined()
})

test('load more appends distinct history and preserves the first page on failure', async () => {
 const api = { followupHistory: vi.fn().mockResolvedValueOnce({ followups: [item], nextCursor: 'next' }).mockRejectedValueOnce(new Error('Retry later')).mockResolvedValue({ followups: [item, { ...item, id: 'two', instruction: 'Second item' }], nextCursor: null }), cancelFollowup: vi.fn() }
 await act(async () => { tree = create(<AgentFollowups api={api as any} agentId="agent" />) })
 const more = () => tree.root.findAllByType('button').find(b => b.children.includes('Load more'))!
 await act(async () => { await more().props.onClick() })
 expect(tree.root.findAllByType('details')).toHaveLength(1)
 expect(tree.root.findByProps({ role: 'alert' }).children).toContain('Retry later')
 await act(async () => { await more().props.onClick() })
 expect(api.followupHistory).toHaveBeenLastCalledWith('agent', 'scheduled', 'next')
 expect(tree.root.findAllByType('details')).toHaveLength(2)
 expect(more()).toBeUndefined()
})

test('a pending additional page cannot leak into a newly selected status', async () => {
 let resolvePage: (value: any) => void = () => {}
 const api = { followupHistory: vi.fn()
  .mockResolvedValueOnce({ followups: [{ ...item, status: 'scheduled' }], nextCursor: 'scheduled-page' })
  .mockImplementationOnce(() => new Promise(resolve => { resolvePage = resolve }))
  .mockResolvedValueOnce({ followups: [{ ...item, id: 'failed-one' }], nextCursor: null }), cancelFollowup: vi.fn() }
 await act(async () => { tree = create(<AgentFollowups api={api as any} agentId="agent" />) })
 let pending: Promise<void> = Promise.resolve()
 act(() => { pending = tree.root.findAllByType('button').find(b => b.children.includes('Load more'))!.props.onClick() })
 await act(async () => { tree.root.findByType('select').props.onChange({ target: { value: 'failed' } }) })
 await act(async () => {
  resolvePage({ followups: [{ ...item, id: 'old-page', instruction: 'Old scheduled page', status: 'scheduled' }], nextCursor: 'obsolete-cursor' })
  await pending
 })
 expect(tree.root.findAllByType('details')).toHaveLength(1)
 expect(JSON.stringify(tree.toJSON())).not.toContain('Old scheduled page')
 expect(tree.root.findAllByType('button').some(b => b.children.includes('Load more'))).toBe(false)
 expect(api.followupHistory).toHaveBeenLastCalledWith('agent', 'failed')
})
