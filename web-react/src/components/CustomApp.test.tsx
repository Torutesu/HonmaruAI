import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { CustomAppFrame } from './CustomApp'
vi.mock('../utils/appearance', () => ({ useAppearance: () => ({ theme: 'dark' }) }))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
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

test('generated apps can read and write fields by their visible column labels', async () => {
  let handler: (e: any) => Promise<void> = async () => {}
  const columnTable = { id: 'tasks', name: 'Tasks', columns: [{ id: 'task_title', name: 'タスク名', type: 'text' }] }
  const row = { id: 'r1', updatedAt: 'v1', values: { task_title: 'Prepare launch' } }
  const contentWindow = { postMessage: vi.fn() }
  const addRow = vi.fn().mockResolvedValue({ row: { id: 'new' } })
  const updateRow = vi.fn().mockResolvedValue({ row })
  vi.stubGlobal('window', { addEventListener: (_: string, fn: any) => { handler = fn }, removeEventListener: vi.fn() })
  let tree: ReturnType<typeof create>
  act(() => { tree = create(<CustomAppFrame html="test" table={columnTable as any} rows={[row] as any} httpBase="https://api.example" api={{ addRow, updateRow } as any} />, { createNodeMock: e => e.type === 'iframe' ? { contentWindow } : null }) })
  await act(async () => { await handler({ source: contentWindow, data: { type: 'honmaru:request', id: 'read', operation: 'read', args: {} } }) })
  expect(contentWindow.postMessage).toHaveBeenLastCalledWith(expect.objectContaining({
    type: 'honmaru:result', id: 'read', value: { table: columnTable, rows: [{ ...row, values: { task_title: 'Prepare launch', 'タスク名': 'Prepare launch' } }] },
  }), '*')
  await act(async () => { await handler({ source: contentWindow, data: { type: 'honmaru:request', id: 'create', operation: 'create', args: { values: { 'タスク名': 'Ship release' } } } }) })
  await act(async () => { await tree!.root.findAllByType('button')[1].props.onClick() })
  expect(addRow).toHaveBeenCalledWith('tasks', { task_title: 'Ship release' }, 'strict')
  await act(async () => { await handler({ source: contentWindow, data: { type: 'honmaru:request', id: 'update', operation: 'update', args: { id: 'r1', values: { 'タスク名': 'Review launch' } } } }) })
  await act(async () => { await tree!.root.findAllByType('button')[1].props.onClick() })
  expect(updateRow).toHaveBeenCalledWith('tasks', 'r1', { task_title: 'Review launch' }, 'v1', 'strict')
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

test('writable preview uses only its private fork and keeps the production SDK response shape',async()=>{
  const {CustomAppEditor}=await import('./CustomApp')
  let handler:(e:any)=>Promise<void>=async()=>{}
  const contentWindow={postMessage:vi.fn()}
  const row={id:'preview-row',values:{name:'Preview'},updatedAt:'v2'}
  const databaseChange=vi.fn().mockResolvedValue({result:row,revision:2})
  const api={appDatabase:vi.fn().mockResolvedValue({fork:{id:'fork',revision:1,entities:[{key:'primary',table,rows:[]}]}}),databaseChange,addRow:vi.fn()}as any
  vi.stubGlobal('window',{addEventListener:(_:string,fn:any)=>{handler=fn},removeEventListener:vi.fn()})
  let tree:ReturnType<typeof create>
  await act(async()=>{tree=create(<CustomAppEditor app={{id:'app',version:1,definition:{custom:{draft:'test'}}}as any} table={table} rows={[]} api={api} reload={()=>{}} httpBase="https://api.example"/>,{createNodeMock:e=>e.type==='iframe'?{contentWindow}:null})})
  await act(async()=>{await Promise.resolve()})
  await act(async()=>{await handler({source:contentWindow,data:{type:'honmaru:request',id:'r',operation:'create',args:{values:{name:'Preview'}}}})})
  const confirm=tree!.root.findAllByType('button').find(b=>b.children.join('')==='この変更を許可')!
  await act(async()=>{await confirm.props.onClick()})
  expect(api.addRow).not.toHaveBeenCalled()
  expect(databaseChange).toHaveBeenCalledWith('app',expect.objectContaining({action:'fork_write',forkId:'fork',revision:1,entity:'primary',operation:'create'}))
  expect(contentWindow.postMessage).toHaveBeenCalledWith(expect.objectContaining({id:'r',value:{row}}),'*')
  act(()=>tree!.unmount())
})


test('runner ready retries early delivery and waits for a matching rendered acknowledgement', () => {
  let handler: (e: any) => void = () => {}
  const contentWindow = { postMessage: vi.fn() }
  vi.stubGlobal('window', { addEventListener: (_: string, fn: any) => { handler = fn }, removeEventListener: vi.fn() })
  let tree: ReturnType<typeof create>
  act(() => { tree = create(<CustomAppFrame html="<h1>Preview</h1>" table={table} rows={[]} httpBase="https://api.example" />, { createNodeMock: e => e.type === 'iframe' ? { contentWindow } : null }) })
  act(() => tree!.root.findByType('iframe').props.onLoad())
  expect(contentWindow.postMessage).toHaveBeenCalledWith(expect.objectContaining({type:'honmaru:init',html:expect.stringContaining('<h1>Preview</h1>')}), '*')
  act(() => handler({source: contentWindow, data:{type:'honmaru:ready'}}))
  expect(contentWindow.postMessage).toHaveBeenCalledTimes(2)
  const renderId=contentWindow.postMessage.mock.calls[0][0].renderId
  act(() => handler({source: {}, data:{type:'honmaru:rendered',renderId}}))
  act(() => handler({source: contentWindow, data:{type:'honmaru:rendered',renderId:'old-frame'}}))
  expect(tree!.root.findAllByProps({role:'status'})).toHaveLength(1)
  act(() => handler({source: contentWindow, data:{type:'honmaru:rendered',renderId}}))
  expect(tree!.root.findAllByProps({role:'status'})).toHaveLength(0)
  act(() => tree!.unmount())
})

test('preview waits for the fork before generated code can read its first snapshot', async () => {
  const {CustomAppEditor}=await import('./CustomApp')
  let resolve!: (value:any)=>void, handler:(e:any)=>void=()=>{}
  const contentWindow={postMessage:vi.fn()}
  const api={appDatabase:vi.fn(()=>new Promise(r=>{resolve=r}))} as any
  vi.stubGlobal('window',{addEventListener:(_:string,fn:any)=>{handler=fn},removeEventListener:vi.fn()})
  let tree:ReturnType<typeof create>
  await act(async()=>{tree=create(<CustomAppEditor app={{id:'app',version:1,definition:{custom:{draft:'test'}}}as any} table={table} rows={[{id:'production',values:{},updatedAt:'p'}]} api={api} reload={()=>{}} httpBase="https://api.example"/>,{createNodeMock:e=>e.type==='iframe'?{contentWindow}:null})})
  expect(tree!.root.findAllByType('iframe')).toHaveLength(0)
  const rows=[{id:'private',values:{name:'Preview'},updatedAt:'f'}]
  await act(async()=>resolve({fork:{id:'fork',revision:1,entities:[{key:'primary',table,rows}]}}))
  act(()=>handler({source:contentWindow,data:{type:'honmaru:request',id:'read',operation:'read'}}))
  expect(contentWindow.postMessage).toHaveBeenCalledWith(expect.objectContaining({id:'read',value:{table,rows}}),'*')
  act(()=>tree!.unmount())
})

test('secondary preview entities read and write only the private database',async()=>{
 const {CustomAppEditor}=await import('./CustomApp')
 let handler:(e:any)=>Promise<void>=async()=>{}
 const contentWindow={postMessage:vi.fn()},people={id:'people-table',name:'People',columns:[{id:'name',name:'Name',type:'text'}]}
 const row={id:'person',values:{name:'Private'},updatedAt:'v1'}
 const databaseChange=vi.fn().mockResolvedValue({result:row,revision:2})
 const api={appDatabase:vi.fn().mockResolvedValue({fork:{id:'fork',revision:1,entities:[{key:'primary',table,rows:[]},{key:'people',table:people,rows:[row]}]}}),databaseChange,addRow:vi.fn(),entityRows:vi.fn()}as any
 vi.stubGlobal('window',{addEventListener:(_:string,fn:any)=>{handler=fn},removeEventListener:vi.fn()})
 let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<CustomAppEditor app={{id:'app',version:1,definition:{custom:{draft:'test'}}}as any} table={table} rows={[]} api={api} reload={()=>{}} httpBase="https://api.example"/>,{createNodeMock:e=>e.type==='iframe'?{contentWindow}:null})})
 await act(async()=>{await Promise.resolve()})
 await act(async()=>handler({source:contentWindow,data:{type:'honmaru:request',id:'read',operation:'entity',args:{entity:'people'}}}))
 expect(contentWindow.postMessage).toHaveBeenCalledWith(expect.objectContaining({id:'read',value:{table:people,rows:[{...row,values:{name:'Private',Name:'Private'}}]}}),'*')
 await act(async()=>handler({source:contentWindow,data:{type:'honmaru:request',id:'write',operation:'update',args:{id:'person',entity:'people',values:{name:'Updated'}}}}))
 expect(databaseChange).not.toHaveBeenCalled()
 await act(async()=>tree!.root.findAllByType('button').find(b=>b.children.join('')==='この変更を許可')!.props.onClick())
 expect(databaseChange).toHaveBeenCalledWith('app',expect.objectContaining({entity:'people',operation:'update',rowId:'person',expectedUpdatedAt:'v1'}))
 expect(api.addRow).not.toHaveBeenCalled();expect(api.entityRows).not.toHaveBeenCalled()
 act(()=>tree!.unmount())
})


test('a runner that never renders exposes retry and ignores old acknowledgements', () => {
  vi.useFakeTimers()
  let handler:(e:any)=>void=()=>{}
  const contentWindow={postMessage:vi.fn()}
  vi.stubGlobal('window',{addEventListener:(_:string,fn:any)=>{handler=fn},removeEventListener:vi.fn()})
  let tree:ReturnType<typeof create>
  act(()=>{tree=create(<CustomAppFrame html="test" table={table} rows={[]} httpBase="https://api.example"/>,{createNodeMock:e=>e.type==='iframe'?{contentWindow}:null})})
  act(()=>tree!.root.findByType('iframe').props.onLoad())
  const oldId=contentWindow.postMessage.mock.calls[0][0].renderId
  act(()=>{vi.advanceTimersByTime(15000)})
  const retry=tree!.root.findByType('button')
  expect(retry.children.join('')).toBe('再試行')
  act(()=>retry.props.onClick())
  expect(tree!.root.findAllByType('button')).toHaveLength(0)
  act(()=>handler({source:contentWindow,data:{type:'honmaru:rendered',renderId:oldId}}))
  expect(tree!.root.findAllByProps({role:'status'})).toHaveLength(1)
  act(()=>tree!.root.findByType('iframe').props.onLoad())
  const nextId=contentWindow.postMessage.mock.calls.at(-1)![0].renderId
  expect(nextId).not.toBe(oldId)
  act(()=>handler({source:contentWindow,data:{type:'honmaru:rendered',renderId:nextId}}))
  act(()=>{vi.advanceTimersByTime(15000)})
  expect(tree!.root.findAllByProps({role:'status'})).toHaveLength(0)
  act(()=>tree!.unmount())
})
