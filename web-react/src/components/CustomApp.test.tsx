import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { CustomAppEditor, CustomAppFrame, CustomAppReleaseHistory } from './CustomApp'
vi.mock('../utils/appearance', () => ({ useAppearance: () => ({ theme: 'dark' }) }))
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })
const table = { id: 'only-this-table', name: 'Tasks', columns: [] }
test('custom app history distinguishes the active published release from a restorable old release', () => {
  const restore = vi.fn()
  let tree: ReturnType<typeof create>
  act(() => { tree = create(<CustomAppReleaseHistory history={[
    { version: 5, note: 'Custom app: publish', createdAt: '2026-11-10T00:00:00Z', release: { publishedAt: '2026-11-10T00:00:00Z', publishedBy: '9101', publishedByName: 'Custom Publisher', source: 'github-commit', commitSha: '0123456789abcdef', current: true } },
    { version: 3, note: 'Custom app: publish', createdAt: '2026-11-08T00:00:00Z', release: { publishedAt: '2026-11-08T00:00:00Z', publishedBy: '9102', source: 'inline', current: false } },
    { version: 4, note: 'Custom app: draft', createdAt: '2026-11-09T00:00:00Z', release: null },
  ]} busy={false} restore={restore} />) })
  const statuses = tree!.root.findAllByProps({ role: 'status' }).map(node => node.children.join(''))
  expect(statuses[0]).toContain('現在公開中')
  expect(statuses[0]).toContain('GitHub 0123456789ab')
  expect(statuses[0]).toContain('公開者 Custom Publisher')
  expect(statuses[1]).toContain('公開した版')
  expect(tree!.root.findAllByType('p').some(node => node.children.join('').includes('公開されていない版'))).toBe(true)
  const buttons = tree!.root.findAllByType('button')
  act(() => { buttons[1].props.onClick() })
  expect(restore).toHaveBeenCalledWith(3)
})
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


const commitState = (status: string) => ({
  commit: { owner:'acme',repo:'static-app',branch:'main',sha:'a'.repeat(40),path:'index.html',sourceHash:'b'.repeat(64),appVersion:3,assets:[] },
  scope: { visibility:'workspace',accessVersion:0,domainScope:'' },
  approval: { id:'approval-1',status,appVersion:3,commitSha:'a'.repeat(40),sourceHash:'b'.repeat(64),visibility:'workspace',requestedBy:'9101',reviewerId:status==='approved'?'9103':null },
});
const editorApp = { id:'app',version:3,definition:{custom:{draft:'<main>release</main>'}} } as any;
const editorTable = { id:'table',name:'Tasks',columns:[] } as any;

test('Git commit editor exposes pending review and displays server self-review rejection', async () => {
  const state=commitState('pending');
  const customCommit=vi.fn().mockRejectedValue(new Error('The reviewer must be independent from the requester.'));
  const api={customCommitState:vi.fn().mockResolvedValue(state),customCommit} as any;
  let tree:ReturnType<typeof create>;
  await act(async()=>{tree=create(<CustomAppEditor app={editorApp} table={editorTable} rows={[]} api={api} reload={vi.fn()} httpBase="https://api.example"/>);await Promise.resolve()});
  expect(tree!.root.findAllByProps({ 'aria-label':'GitHub commit approval' })).toHaveLength(1);
  expect(tree!.root.findAllByType('button').some(button=>button.children.join('')==='Owner/Adminとして承認')).toBe(true);
  const review=tree!.root.findAllByType('button').find(button=>button.children.join('')==='Owner/Adminとして承認')!;
  await act(async()=>{await review.props.onClick()});
  expect(customCommit).toHaveBeenCalledWith('app',expect.objectContaining({
    action:'review_commit_approval',decision:'approve',approvalId:'approval-1',commitSha:'a'.repeat(40),sourceHash:'b'.repeat(64),
  }));
  expect(tree!.root.findAllByProps({role:'alert'}).some(node=>String(node.children.join('')).includes('independent'))).toBe(true);
  act(()=>tree!.unmount());
});

test('Git commit editor disables stale approvals after the API reports a publish conflict', async () => {
  const state=commitState('approved');
  const customCommit=vi.fn().mockRejectedValue(new Error('The commit approval is stale or no longer matches the publish scope.'));
  const api={customCommitState:vi.fn().mockResolvedValue(state),customCommit} as any;
  let tree:ReturnType<typeof create>;
  await act(async()=>{tree=create(<CustomAppEditor app={editorApp} table={editorTable} rows={[]} api={api} reload={vi.fn()} httpBase="https://api.example"/>);await Promise.resolve()});
  const publish=tree!.root.findAllByType('button').find(button=>button.children.join('')==='承認済みGitHub commitを公開')!;
  await act(async()=>{publish.props.onClick();await new Promise(resolve=>setTimeout(resolve,0))});
  expect(customCommit).toHaveBeenCalledWith('app',expect.objectContaining({action:'publish_commit',version:3,approvalId:'approval-1'}));
  expect(tree!.root.findAllByProps({role:'alert'}).some(node=>String(node.children.join('')).includes('publish scope'))).toBe(true);
  act(()=>tree!.unmount());
});

test('Git commit editor imports through its API action and publishes only after approval', async () => {
  let current=commitState('approved');
  const customCommit=vi.fn(async(_id:string,input:any)=>{
    if(input.action==='publish_commit')current={...current,approval:{...current.approval,status:'published'}};
    return {saved:true};
  });
  const api={customCommitState:vi.fn(async()=>current),customCommit} as any;
  const reload=vi.fn();
  let tree:ReturnType<typeof create>;
  await act(async()=>{tree=create(<CustomAppEditor app={editorApp} table={editorTable} rows={[]} api={api} reload={reload} httpBase="https://api.example"/>);await Promise.resolve()});
  const owner=tree!.root.findByProps({ 'aria-label':'GitHub owner' });
  const repo=tree!.root.findByProps({ 'aria-label':'GitHub repository' });
  const branch=tree!.root.findByProps({ 'aria-label':'GitHub branch' });
  const sha=tree!.root.findByProps({ 'aria-label':'GitHub commit SHA' });
  act(()=>{owner.props.onChange({target:{value:'acme'}});repo.props.onChange({target:{value:'static-app'}});branch.props.onChange({target:{value:'main'}});sha.props.onChange({target:{value:'a'.repeat(40)}})});
  const importButton=tree!.root.findAllByType('button').find(button=>button.children.join('')==='commitのHTMLと静的アセットを取り込む')!;
  await act(async()=>{importButton.props.onClick();await new Promise(resolve=>setTimeout(resolve,0))});
  expect(customCommit).toHaveBeenCalledWith('app',expect.objectContaining({action:'import_commit',owner:'acme',repo:'static-app',branch:'main',commitSha:'a'.repeat(40)}));
  expect(reload).toHaveBeenCalled();
  const publish=tree!.root.findAllByType('button').find(button=>button.children.join('')==='承認済みGitHub commitを公開')!;
  await act(async()=>{await publish.props.onClick()});
  expect(customCommit).toHaveBeenCalledWith('app',expect.objectContaining({action:'publish_commit',version:3,approvalId:'approval-1'}));
  expect(reload).toHaveBeenCalledTimes(2);
  act(()=>tree!.unmount());
});

test('custom domain publishing requires a visible explicit all-records consent', async () => {
  const hosting={configured:true,project:'honmaru-web',dnsTarget:'',domain:null,environment:[]};
  const changeAppHosting=vi.fn().mockResolvedValue({saved:true});
  const api={customCommitState:vi.fn().mockResolvedValue(commitState('none')),appHosting:vi.fn().mockResolvedValue(hosting),changeAppHosting} as any;
  const app={...editorApp,definition:{custom:{draft:'<main>release</main>',published:'<main>release</main>'}}};
  let tree:ReturnType<typeof create>;
  await act(async()=>{tree=create(<CustomAppEditor app={app} table={editorTable} rows={[]} api={api} reload={vi.fn()} httpBase="https://api.example"/>);await Promise.resolve()});
  const panel=tree!.root.findByProps({'aria-label':'カスタムドメイン公開'});
  expect(JSON.stringify(tree!.toJSON())).toContain('このドメインではカスタム画面と全レコードを誰でも閲覧できます');
  const hostname=tree!.root.findByProps({'aria-label':'独自ドメインのホスト名'});
  act(()=>hostname.props.onChange({target:{value:'app.example.com'}}));
  const checkbox=tree!.root.findByProps({'aria-label':'全レコードの公開を確認'});
  const attach=tree!.root.findAllByType('button').find(button=>button.children.join('')==='独自ドメインを追加')!;
  expect(attach.props.disabled).toBe(true);
  act(()=>checkbox.props.onChange({target:{checked:true}}));
  expect(attach.props.disabled).toBe(false);
  await act(async()=>{await attach.props.onClick()});
  expect(changeAppHosting).toHaveBeenCalledWith('app',{action:'attach',hostname:'app.example.com',publicDataConfirmed:true});
  act(()=>tree!.unmount());
});

test('custom app editor exposes the independent approval gate for a saved draft',async()=>{
 const {CustomAppEditor}=await import('./CustomApp')
 let state:any={policy:{enabled:true},draftVersion:2,sourceHash:'hash',scope:'custom-app.publish',approval:null}
 vi.stubGlobal('window',{addEventListener:vi.fn(),removeEventListener:vi.fn(),confirm:vi.fn(()=>true)})
 const api={customPublishState:vi.fn(async()=>state),customPublish:vi.fn(async(_id:string,input:any)=>{if(input.action==='request_approval')state={...state,approval:{id:'approval',status:'pending',requestedBy:'maker',reviewerId:null,sourceHash:'hash',draftVersion:2,scope:'custom-app.publish'}};return {saved:true}}),appDatabase:vi.fn().mockResolvedValue({fork:null})}as any
 let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<CustomAppEditor app={{id:'app',version:2,definition:{custom:{draft:'<h1>saved</h1>'}}}as any} table={table} rows={[]} api={api} reload={()=>{}} httpBase="https://api.example"/>)} )
 expect(tree!.root.findAllByProps({'aria-label':'公開承認ポリシー'})).toHaveLength(1)
 const request=tree!.root.findAllByType('button').find(b=>b.children.join('')==='この保存済み下書きの承認を依頼')!
 await act(async()=>request.props.onClick())
 expect(api.customPublish).toHaveBeenCalledWith('app',expect.objectContaining({action:'request_approval',version:2}))
 expect(tree!.root.findAllByProps({role:'status'}).some(n=>n.children.join('').includes('pending'))).toBe(true)
 act(()=>tree!.unmount())
})
