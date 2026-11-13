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

test('history links to its source thread in the owning workspace only when one exists', async () => {
 const api = { orgId: 'team:acme', followupHistory: vi.fn().mockResolvedValue({ followups: [
  { ...item, threadId: 'source/thread' }, { ...item, id: 'no-thread', threadId: null }
 ], nextCursor: null }), cancelFollowup: vi.fn() }
 await act(async () => { tree = create(<AgentFollowups api={api as any} agentId="agent" />) })
 const links = tree.root.findAllByType('a')
 expect(links).toHaveLength(1)
 expect(links[0].children).toEqual(['View conversation'])
 expect(links[0].props.href).toBe('#/t/source%2Fthread/team%3Aacme')
 expect(api.cancelFollowup).not.toHaveBeenCalled()
})

test('all status history retains cancellation only for pending follow-ups', async () => {
 const api = { followupHistory: vi.fn().mockResolvedValueOnce({followups:[]}).mockResolvedValue({followups:[{...item,status:'scheduled'}, {...item,id:'done',status:'done'}],nextCursor:null}), cancelFollowup:vi.fn() }
 await act(async () => {tree=create(<AgentFollowups api={api as any} agentId="agent" />)})
 await act(async () => {tree.root.findByType('select').props.onChange({target:{value:'all'}})})
 expect(api.followupHistory).toHaveBeenLastCalledWith('agent','all')
 expect(tree.root.findAllByType('option').some(o=>o.props.value==='all')).toBe(true)
 expect(tree.root.findAllByType('button').filter(b=>b.children.includes('Cancel'))).toHaveLength(1)
})

// The server lets a running follow-up be cancelled only once its 30-minute
// claim has run out, or when it has no claim time at all.
test('a running follow-up offers cancellation only after its lease has run out', async () => {
 const running = { ...item, status: 'running', result: null }
 const api = { followupHistory: vi.fn().mockResolvedValue({ followups: [
  { ...running, id: 'live', instruction: 'Live item', claimedAt: new Date().toISOString() },
  { ...running, id: 'stuck', instruction: 'Stuck item', claimedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() },
  { ...running, id: 'legacy', instruction: 'Legacy item', claimedAt: null },
 ], nextCursor: null }), cancelFollowup: vi.fn().mockResolvedValue({ cancelled: true }) }
 await act(async () => { tree = create(<AgentFollowups api={api as any} agentId="agent" />) })
 const rowFor = (text: string) => tree.root.findAll(node => node.type === 'div' && node.props.className === 'row static').find(row => row.findByProps({ className: 'row-main' }).children.includes(text))!
 const cancelIn = (text: string) => rowFor(text).findAllByType('button').find(b => b.children.includes('Cancel'))
 expect(cancelIn('Live item')).toBeUndefined()
 expect(cancelIn('Stuck item')).toBeTruthy()
 expect(cancelIn('Legacy item')).toBeTruthy()
 await act(async () => { await cancelIn('Stuck item')!.props.onClick() })
 expect(api.cancelFollowup).toHaveBeenCalledWith('stuck')
})

test('a follow-up that is still inside its lease explains why it was not cancelled', async () => {
 const { HarnessApiError } = await import('../utils/harness')
 const stuck = { ...item, status: 'running', result: null, claimedAt: new Date(Date.now() - 31 * 60 * 1000).toISOString() }
 const api = { followupHistory: vi.fn().mockResolvedValue({ followups: [stuck], nextCursor: null }),
  cancelFollowup: vi.fn().mockRejectedValue(new HarnessApiError('This follow-up is running now. Try again if it has not finished in a while.', 409)) }
 await act(async () => { tree = create(<AgentFollowups api={api as any} agentId="agent" />) })
 await act(async () => { await tree.root.findAllByType('button').find(b => b.children.includes('Cancel'))!.props.onClick() })
 expect(tree.root.findByProps({ role: 'alert' }).children).toContain('This follow-up is still running. Try again if it has not finished within 30 minutes.')
 expect(tree.root.findAllByType('button').some(b => b.children.includes('Cancel'))).toBe(true)
})
