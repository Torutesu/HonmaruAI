import React, { act } from 'react'
import { create, type ReactTestInstance } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { AgentMemoryPromotions } from './AgentMemoryPromotions'

const request = { id: 'request-1', agentId: 'agent', memoryId: 'private-memory-1', sourceVersion: 3, scope: 'person' as const, requesterId: 'user-1', requesterLogin: 'alice', status: 'pending' as const, createdAt: '2026-11-10T00:00:00Z', sourceCurrent: true, sourceAccess: true, source: { title: 'Private title', description: 'Source context', body: 'Captured private memory text', version: 3 } }
afterEach(() => vi.restoreAllMocks())

test('maker queue shows source details and decision metadata, then refreshes after decision', async () => {
  const load = vi.fn().mockResolvedValueOnce({ canDecide: true, requests: [request] }).mockResolvedValueOnce({ canDecide: true, requests: [{ ...request, status: 'approved', decidedBy: 'owner', decidedAt: '2026-11-10T01:00:00Z', sharedMemoryId: 'shared-copy' }] })
  const decide = vi.fn().mockResolvedValue({})
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<AgentMemoryPromotions load={load} decide={decide} />) })
  const initial = JSON.stringify(tree.toJSON())
  expect(initial).toContain('private-memory-1')
  expect(initial).toContain('version 3')
  expect(initial).toContain('alice')
  expect(initial).toContain('Captured private memory text')
  expect(initial).toContain('Private title')
  const approve = tree.root.findAllByType('button').find(button => button.children.includes('Approve shared copy'))!
  await act(async () => { approve.props.onClick() })
  expect(decide).toHaveBeenCalledWith('request-1', 'approve')
  expect(load).toHaveBeenCalledTimes(2)
  const after = JSON.stringify(tree.toJSON())
  expect(after).toContain('owner')
  expect(after).toContain('shared-copy')
  act(() => tree.unmount())
})

test('requester can see own status without reviewer decision controls', async () => {
  const load = vi.fn().mockResolvedValue({ canDecide: false, requests: [{ ...request, status: 'rejected', decidedBy: 'owner', decidedAt: request.createdAt }] })
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<AgentMemoryPromotions load={load} decide={vi.fn()} />) })
  expect(tree.root.findAllByType('button').map((button: ReactTestInstance) => button.children.join(''))).toContain('Refresh')
  expect(tree.root.findAllByType('button').some(button => button.children.includes('Approve shared copy'))).toBe(false)
  expect(JSON.stringify(tree.toJSON())).toContain('Decision by owner')
  act(() => tree.unmount())
})

test('pending requests with a changed source are marked stale and cannot be approved', async () => {
  const stale = { ...request, sourceCurrent: false, source: null }
  const load = vi.fn().mockResolvedValue({ canDecide: true, requests: [stale] })
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<AgentMemoryPromotions load={load} decide={vi.fn()} />) })
  expect(JSON.stringify(tree.toJSON())).toContain('Stale')
  const approve = tree.root.findAllByType('button').find(button => button.children.includes('Approve shared copy'))!
  expect(approve.props.disabled).toBe(true)
  act(() => tree.unmount())
})

test('refresh clears previously visible source text immediately and keeps it cleared when access check fails', async () => {
  let reject!: (error: Error) => void
  const load = vi.fn().mockResolvedValueOnce({ canDecide: true, requests: [request] }).mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail }))
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<AgentMemoryPromotions load={load} decide={vi.fn()} />) })
  expect(JSON.stringify(tree.toJSON())).toContain('Captured private memory text')
  act(() => { tree.root.findAllByType('button').find(button => button.children.includes('Refresh'))!.props.onClick() })
  expect(JSON.stringify(tree.toJSON())).not.toContain('Captured private memory text')
  await act(async () => { reject(new Error('Access changed')) })
  expect(JSON.stringify(tree.toJSON())).not.toContain('Captured private memory text')
  expect(JSON.stringify(tree.toJSON())).toContain('Access changed')
  act(() => tree.unmount())
})
