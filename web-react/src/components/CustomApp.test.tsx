import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { CustomAppFrame } from './CustomApp'
vi.mock('../utils/appearance', () => ({ useAppearance: () => ({ theme: 'dark' }) }))
afterEach(() => vi.unstubAllGlobals())
const table = { id: 'only-this-table', name: 'Tasks', columns: [] }
test('generated code cannot mutate data before host approval or choose another table', async () => {
  let handler: (e: any) => void = () => {}
  const postMessage = vi.fn(), addRow = vi.fn().mockResolvedValue({ row: { id: 'new' } })
  const contentWindow = { postMessage }
  vi.stubGlobal('window', { addEventListener: (_: string, fn: any) => { handler = fn }, removeEventListener: vi.fn() })
  let tree: ReturnType<typeof create>
  act(() => { tree = create(<CustomAppFrame html="<h1>test</h1>" table={table} rows={[]} httpBase="https://api.example" api={{ addRow } as any} />, { createNodeMock: e => e.type === 'iframe' ? { contentWindow } : null }) })
  const data = { type: 'honmaru:request', id: 'r', operation: 'create', args: { tableId: 'foreign', values: { name: 'Task' } } }
  act(() => handler({ source: {}, data }))
  expect(tree!.root.findAllByProps({ role: 'alertdialog' })).toHaveLength(0)
  act(() => handler({ source: contentWindow, data }))
  expect(addRow).not.toHaveBeenCalled()
  await act(async () => { await tree!.root.findAllByType('button')[1].props.onClick() })
  expect(addRow).toHaveBeenCalledWith('only-this-table', { name: 'Task' })
  expect(postMessage).toHaveBeenCalledWith(expect.objectContaining({ type: 'honmaru:result', id: 'r' }), '*')
  act(() => tree!.unmount())
})
test('preview rejects writes without displaying an approval action', () => {
  let handler: (e: any) => void = () => {}
  const contentWindow = { postMessage: vi.fn() }
  vi.stubGlobal('window', { addEventListener: (_: string, fn: any) => { handler = fn }, removeEventListener: vi.fn() })
  let tree: ReturnType<typeof create>
  act(() => { tree = create(<CustomAppFrame html="test" table={table} rows={[]} httpBase="https://api.example" />, { createNodeMock: e => e.type === 'iframe' ? { contentWindow } : null }) })
  act(() => handler({ source: contentWindow, data: { type: 'honmaru:request', id: 'r', operation: 'remove', args: { id: 'row' } } }))
  expect(contentWindow.postMessage).toHaveBeenCalledWith(expect.objectContaining({ error: 'Preview is read-only.' }), '*')
  expect(tree!.root.findAllByProps({ role: 'alertdialog' })).toHaveLength(0)
  act(() => tree!.unmount())
})
