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
  expect(addRow).toHaveBeenCalledWith('only-this-table', { name: 'Task' }, 'strict')
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

test('approval keeps the row revision that was shown when the change was requested', async () => {
  let handler: (e: any) => void = () => {}
  const contentWindow = { postMessage: vi.fn() }
  const updateRow = vi.fn().mockResolvedValue({ row: { id: 'r1' } })
  const api = { updateRow } as any
  vi.stubGlobal('window', { addEventListener: (_: string, fn: any) => { handler = fn }, removeEventListener: vi.fn() })
  const element = (updatedAt: string) => <CustomAppFrame html="test" table={table} rows={[{ id: 'r1', updatedAt, values: { name: updatedAt } }]} httpBase="https://api.example" api={api} />
  let tree: ReturnType<typeof create>
  act(() => { tree = create(element('revision-1'), { createNodeMock: e => e.type === 'iframe' ? { contentWindow } : null }) })
  act(() => handler({ source: contentWindow, data: { type: 'honmaru:request', id: 'request', operation: 'update', args: { id: 'r1', values: { name: 'Approved edit' } } } }))
  act(() => tree!.update(element('revision-2')))
  expect(tree!.root.findByType('pre').children.join('')).toContain('revision-1')
  expect(tree!.root.findByType('pre').children.join('')).not.toContain('revision-2')
  await act(async () => { await tree!.root.findAllByType('button')[1].props.onClick() })
  expect(updateRow).toHaveBeenCalledWith('only-this-table', 'r1', { name: 'Approved edit' }, 'revision-1', 'strict')
  act(() => tree!.unmount())
})

test('a generated external request requires host approval and uses the discovered connection version', async () => {
  let handler: (e: any) => Promise<void> = async () => {}
  const contentWindow = { postMessage: vi.fn() }
  const connectionChange = vi.fn().mockResolvedValue({ data: { ok: true } })
  const api = { appConnections: vi.fn().mockResolvedValue({ connections: [{ name: 'github', version: 7, enabled: 1, endpoint: 'https://api.github.com/user' }] }), connectionChange } as any
  vi.stubGlobal('window', { addEventListener: (_: string, fn: any) => { handler = fn }, removeEventListener: vi.fn() })
  let tree: ReturnType<typeof create>
  act(() => { tree = create(<CustomAppFrame appId="app" html="test" table={table} rows={[]} httpBase="https://api.example" api={api}/>, { createNodeMock: e => e.type === 'iframe' ? { contentWindow } : null }) })
  await act(async () => { await handler({ source: contentWindow, data: { type: 'honmaru:request', id: 'request', operation: 'connect', args: { name: 'github', endpoint: 'https://evil.test' } } }) })
  expect(connectionChange).not.toHaveBeenCalled()
  expect(tree!.root.findByType('pre').children.join('')).toContain('https://api.github.com/user')
  expect(tree!.root.findByType('pre').children.join('')).not.toContain('evil.test')
  await act(async () => { await tree!.root.findAllByType('button')[1].props.onClick() })
  expect(connectionChange).toHaveBeenCalledWith('app', { action: 'request', name: 'github', version: 7, body: undefined, requestId: 'request' })
  act(() => tree!.unmount())
})
test('server execution approval fixes the published code version and never accepts code from the iframe',async()=>{
  let handler: (e:any)=>Promise<void>=async()=>{}
  const contentWindow={postMessage:vi.fn()}
  const actionChange=vi.fn().mockResolvedValue({job:{id:'job'}})
  const api={appActions:vi.fn().mockResolvedValue({actions:[{name:'sum',published:'return input.a+input.b',publishedVersion:2}]}),gateways:vi.fn().mockResolvedValue({gateways:[{id:'mac'}]}),actionChange}as any
  vi.stubGlobal('window',{addEventListener:(_:string,fn:any)=>{handler=fn},removeEventListener:vi.fn()})
  let tree:ReturnType<typeof create>
  act(()=>{tree=create(<CustomAppFrame appId="app" html="test" table={table} rows={[]} httpBase="https://api.example" api={api}/>,{createNodeMock:e=>e.type==='iframe'?{contentWindow}:null})})
  await act(async()=>{await handler({source:contentWindow,data:{type:'honmaru:request',id:'r',operation:'run',args:{name:'sum',input:{a:20,b:22},gatewayId:'mac',code:'evil'}}})})
  expect(actionChange).not.toHaveBeenCalled()
  expect(tree!.root.findByType('pre').children.join('')).toContain('return input.a+input.b')
  await act(async()=>{await tree!.root.findAllByType('button')[1].props.onClick()})
  expect(actionChange).toHaveBeenCalledWith('app',{action:'run',name:'sum',version:2,gatewayId:'mac',input:{a:20,b:22},requestId:'r'})
  act(()=>tree!.unmount())
})
