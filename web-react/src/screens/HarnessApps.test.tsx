import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AppView, HarnessApps, HarnessTemplateImport, appTableDisplayName, newAppRecordLabel } from './Harness'
import { HarnessApiError, harnessApi } from '../utils/harness'

const state = vi.hoisted(() => ({ api: null as any }))
vi.mock('./HarnessShared', async importOriginal => ({
  ...await importOriginal<typeof import('./HarnessShared')>(),
  useApi: () => state.api,
}))
vi.mock('../utils/i18n', () => {
  const identity = (text: string) => text
  return { useT: () => identity }
})
vi.mock('../utils/appPins', () => ({ useAppPins: () => ({ pins: [], toggle: vi.fn() }) }))
let finish: (value: any) => void
let tree: ReturnType<typeof create> | undefined
test('new record labels use the primary table when its title differs from the app',()=>{
  expect(newAppRecordLabel('UI確認用タスク','タスク')).toBe('新規タスク')
  expect(newAppRecordLabel('UI確認用タスク','UI確認用タスク','タスク名')).toBe('新規タスク')
  expect(newAppRecordLabel('Contacts','Contacts','名前')).toBe('新規レコード')
  expect(newAppRecordLabel('Issues','Issues','件名')).toBe('新規レコード')
  expect(newAppRecordLabel('Sales CRM','Sales CRM')).toBe('新規レコード')
})
test('table headings show the record type when the app and table share a name',()=>{
  expect(appTableDisplayName('UI確認用タスク','UI確認用タスク','タスク名')).toBe('タスク')
  expect(appTableDisplayName('Sales CRM','Contacts','Name')).toBe('Contacts')
  expect(appTableDisplayName('Contacts','Contacts','名前')).toBe('Contacts')
})
beforeEach(() => {
  vi.stubGlobal('location', { hash: '#/apps' })
  vi.stubGlobal('fetch', vi.fn(async (input: string) => ({
    ok: true,
    json: async () => input.includes('/orgs/mode') ? { mode: 'harness' } : { servers: [], canManage: true },
  })))
  state.api = {
    apps: vi.fn().mockResolvedValue({ apps: [] }),
    templates: vi.fn().mockResolvedValue({ templates: [] }),
    generate: vi.fn(() => new Promise(resolve => { finish = resolve })),
    app: vi.fn(() => new Promise(() => {})),
    personalViews: vi.fn(() => new Promise(() => {})),
    conversation: vi.fn().mockResolvedValue({ messages: [], hasMore: false, annotations: [] }),
  }
})
afterEach(() => { if (tree) act(() => tree!.unmount()); tree = undefined; vi.unstubAllGlobals() })
const button = (label: string) => tree!.root.findAllByType('button').find(node => node.props.children === label)!
test('Remote MCP server settings are available from the Harness Apps library', async () => {
  await act(async () => { tree = create(<HarnessApps httpBase="https://api.example" orgId="team:one" sessionToken="one" onClose={() => {}} />) })
  expect(tree!.root.findByProps({ id: 'remote-mcp-title' }).children).toContain('Remote MCP servers')
  expect(tree!.root.findAllByProps({ className: 'remote-mcp-empty' }).some(node => node.children.includes('No Remote MCP servers connected yet.'))).toBe(true)
})
test('public MCP catalog results can be reviewed and selected for the connection form', async () => {
  const registryServer = {
    name: 'io.github.example/calendar', title: 'Calendar MCP', description: 'Manage calendar events', version: '1.2.0',
    endpoint: 'https://calendar.example.com/mcp', headers: [{ name: 'Authorization', required: true, description: 'Paste a token from the provider.' }],
  }
  const fetchStub = vi.fn(async (input: string) => ({
    ok: true,
    json: async () => input.includes('/orgs/mode')
      ? { mode: 'harness' }
      : input.includes('/remote-mcp/registry') ? { servers: [registryServer], nextCursor: null } : { servers: [], canManage: true },
  }))
  vi.stubGlobal('fetch', fetchStub)
  await act(async () => { tree = create(<HarnessApps httpBase="https://api.example" orgId="team:one" sessionToken="one" onClose={() => {}} />) })
  const search = tree!.root.findByProps({ 'aria-label': 'Search MCP servers' })
  act(() => search.props.onChange({ target: { value: 'calendar' } }))
  const searchForm = tree!.root.findByProps({ className: 'remote-mcp-catalog-search' })
  await act(async () => {
    searchForm.props.onSubmit({ preventDefault: vi.fn() })
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  expect(fetchStub.mock.calls.map(([url]) => url)).toContain('https://api.example/remote-mcp/registry?q=calendar&orgId=team%3Aone')
  expect(tree!.root.findByProps({ 'data-registry-server': registryServer.name }).findAllByType('strong')[0].children).toContain('Calendar MCP')
  await act(async () => { tree!.root.findAllByType('button').find(node => node.children.includes('Use server'))!.props.onClick() })
  expect(tree!.root.findAllByType('input').map(node => node.props.value)).toContain('Calendar MCP')
  expect(tree!.root.findAllByType('input').map(node => node.props.value)).toContain('https://calendar.example.com/mcp')
  expect(tree!.root.findByProps({ className: 'remote-mcp-message' }).children).toContain('The listing marks these headers as required. Enter credentials yourself; registry examples are never copied.')
  expect(tree!.root.findByProps({ 'aria-label': 'Header value' }).props.required).toBe(true)
  expect(tree!.root.findByProps({ 'aria-label': 'Header value' }).props['aria-description']).toBe('Paste a token from the provider.')
  expect(tree!.root.findAllByType('select')[0].props.value).toBe('headers')
  await act(async () => {
    tree!.root.findAllByType('button').find(node => node.children.includes('Browse catalog'))!.props.onClick()
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  expect(fetchStub.mock.calls.map(([url]) => url)).toContain('https://api.example/remote-mcp/registry?orgId=team%3Aone')
})
test('Remote MCP OAuth lets members connect their own account from the Harness Apps screen', async () => {
  const oauthServer = {
    id: 'oauth-server', name: 'Private CRM', endpoint: 'https://mcp.crm.example.com/mcp', hasAuthentication: true,
    authMode: 'oauth', oauthRegistration: 'auto', oauthConnected: false, tools: [], allowedTools: [], connectedAt: null,
    createdAt: '2026-11-01T00:00:00Z',
  }
  const fetchStub = vi.fn(async (input: string) => ({
    ok: true,
    json: async () => input.includes('/orgs/mode') ? { mode: 'harness' } : { servers: [oauthServer], canManage: true },
  }))
  vi.stubGlobal('fetch', fetchStub)
  await act(async () => { tree = create(<HarnessApps httpBase="https://api.example" orgId="team:one" sessionToken="one" onClose={() => {}} />) })
  expect(fetchStub.mock.calls.map(([url]) => url)).toContain('https://api.example/remote-mcp?orgId=team%3Aone')
  expect(JSON.stringify(tree!.toJSON())).toContain('Private CRM')
  expect(tree!.root.findAllByType('button').some(node => node.children.includes('Connect my account'))).toBe(true)
  const authSelect = tree!.root.findAllByType('select')[0]
  expect(authSelect.findAllByType('option').map(node => node.props.value)).toContain('oauth')
  act(() => authSelect.props.onChange({ target: { value: 'oauth' } }))
  expect(JSON.stringify(tree!.toJSON())).toContain('Workflow runs use the workflow creator’s connected account.')
})
async function start(prompt='First request') {
  await act(async () => { tree = create(<HarnessApps httpBase="https://api.example" orgId="team:one" sessionToken="one" onClose={() => {}} />) })
  act(() => button('Build an app').props.onClick())
  act(() => tree!.root.findByType('textarea').props.onChange({ target: { value: prompt } }))
  let completion!: Promise<void>
  act(() => { completion = button('Build').props.onClick() })
  return { completion }
}
test('generation still opens its app when the same screen is active', async () => {
  const { completion } = await start()
  await act(async () => { finish({ app: { id: 'created' }, source: 'template' }); await completion })
  expect(location.hash).toBe('#/apps/created/team%3Aone')
})
test('only a fenced obsolete generation starts a new request on retry', async () => {
  state.api.generate.mockRejectedValueOnce(new Error('Network failed'))
    .mockRejectedValueOnce(new HarnessApiError('Old proposal stopped',409,'APP_GENERATION_OBSOLETE_UNPUBLISHED'))
    .mockResolvedValueOnce({app:{id:'created'},source:'template'})
  const { completion } = await start('A tracker')
  await act(async () => { await completion })
  const firstId=state.api.generate.mock.calls[0][2].requestId
  await act(async () => { await button('Build').props.onClick() })
  expect(state.api.generate.mock.calls[1][2].requestId).toBe(firstId)
  expect(JSON.stringify(tree!.toJSON())).toContain('Old proposal stopped')
  await act(async () => { await button('Build').props.onClick() })
  expect(state.api.generate.mock.calls[2][2].requestId).not.toBe(firstId)
  expect(location.hash).toBe('#/apps/created/team%3Aone')
})
test('the API retains the status and code of an obsolete generation response', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ok:false,status:409,json:async()=>({message:'Old proposal stopped',code:'APP_GENERATION_OBSOLETE_UNPUBLISHED'})}))
  await expect(harnessApi('https://api.example','team:one','one').generate('A tracker',undefined,{requestId:'test_request_id_001'}))
    .rejects.toMatchObject({message:'Old proposal stopped',status:409,code:'APP_GENERATION_OBSOLETE_UNPUBLISHED'})
})
test('other 409 responses preserve the generation request ID', async () => {
  state.api.generate.mockRejectedValueOnce(new HarnessApiError('Still creating',409))
    .mockResolvedValueOnce({app:{id:'created'},source:'template'})
  const {completion}=await start('A tracker')
  await act(async()=>{await completion})
  const firstId=state.api.generate.mock.calls[0][2].requestId
  await act(async()=>{await button('Build').props.onClick()})
  expect(state.api.generate.mock.calls[1][2].requestId).toBe(firstId)
})
test('room generation opens the saved source route rather than a detached app panel',async()=>{
 const {completion}=await start('Build a tracker for #general')
 await act(async()=>{finish({app:{id:'created'},source:'template'});await completion})
 expect(state.api.generate).toHaveBeenCalledWith('Build a tracker for #general','b:general',expect.objectContaining({captureSource:true}))
 expect(location.hash).toBe('#/apps/created/team%3Aone?source=1')
})
test('sample rows are empty by default and the selected limit is submitted',async()=>{
 await act(async()=>{tree=create(<HarnessApps httpBase="https://api.example" orgId="team:one" sessionToken="one" onClose={()=>{}}/>)})
 act(()=>button('Build an app').props.onClick())
 act(()=>tree!.root.findByType('textarea').props.onChange({target:{value:'Invoice tracker with sample data'}}))
 const limit=tree!.root.findByProps({'aria-label':'Maximum sample rows'})
 expect(limit.props.value).toBe(0)
 expect(tree!.root.findByProps({role:'status'}).children).toContain('To include sample rows, choose a limit under Initial data.')
 act(()=>limit.props.onChange({target:{value:'1'}}))
 let completion!:Promise<void>
 act(()=>{completion=button('Build').props.onClick()})
 expect(state.api.generate).toHaveBeenCalledWith('Invoice tracker with sample data',undefined,expect.objectContaining({sampleCount:1}))
 await act(async()=>{finish({app:{id:'created'},source:'template'});await completion})
 await act(async()=>{tree!.root.findByType(AppView).props.onBack()})
 expect(tree!.root.findByProps({'aria-label':'Maximum sample rows'}).props.value).toBe(0)
})
test('opening an app from the library starts in its data viewer', async () => {
  state.api.apps.mockResolvedValue({ apps: [{
    id: 'existing', name: 'Tracker', description: 'A task tracker', icon: 'grid', tableId: 'tasks',
    template: null, version: 2, createdBy: 'user', updatedAt: '2026-10-31T00:00:00Z', channels: [],
    definition: { views: [], custom: { published: '<main></main>' } },
  }] })
  await act(async () => { tree = create(<HarnessApps httpBase="https://api.example" orgId="team:one" sessionToken="one" onClose={() => {}} />) })
  await act(async () => { tree!.root.findByProps({ 'aria-label': 'Trackerを開く' }).props.onClick() })
  expect(location.hash).toBe('#/apps/existing/team%3Aone?section=data')
})
test('the app data viewer keeps one record-create action in the table toolbar', async () => {
  vi.stubGlobal('document', { addEventListener: vi.fn(), removeEventListener: vi.fn(), visibilityState: 'visible' })
  state.api = {
    app: vi.fn().mockResolvedValue({
      app: { id: 'tasks', name: 'UI確認用タスク', description: '', icon: 'grid', tableId: 'tasks', template: null, version: 1, createdBy: 'owner', channels: [], definition: { views: [] } },
      table: { id: 'tasks', orgId: 'team:one', name: 'UI確認用タスク', columns: [{ id: 'title', name: 'タスク名', type: 'text' }] },
      rows: [], views: [{ id: 'all', type: 'table', name: 'All tasks', rows: [] }], canCustomize: true,
    }),
    personalViews: vi.fn().mockResolvedValue({ revision: 0, views: [], computed: [], layouts: {} }),
    conversation: vi.fn().mockResolvedValue({ messages: [], hasMore: false, annotations: [] }),
    conversationNotifications: vi.fn().mockResolvedValue({ items: [] }),
    templateShares: vi.fn().mockResolvedValue({ shares: [], canManage: true }),
    versions: vi.fn().mockResolvedValue({ versions: [] }),
  }
  await act(async () => {
    tree = create(<AppView httpBase="https://api.example" orgId="team:one" sessionToken="one" onClose={() => {}} api={state.api} appId="tasks" onBack={() => {}} initialSection="data" />)
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  const createActions = tree!.root.findAllByProps({ className: 'pill-btn hx-create-record' })
  expect(createActions).toHaveLength(1)
  expect(createActions[0].children).toContain('新規タスク')
  expect(tree!.root.findAllByType('h2').some(node => node.children.includes('タスク'))).toBe(true)
  expect(tree!.root.findAllByType('button').some(node => node.children.includes('Add a row'))).toBe(false)
})
test('a shared personal-looking ID and a legacy collision never expose personal deletion',async()=>{
  vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn(),visibilityState:'visible'})
  const shared={id:'personal_collision',type:'table',name:'Shared',rows:[]}
  const personal={...shared,name:'Old personal'}
  state.api={
    app:vi.fn().mockResolvedValue({app:{id:'tasks',name:'Tasks',description:'',icon:'grid',tableId:'tasks',template:null,version:1,createdBy:'owner',channels:[],definition:{views:[shared]}},table:{id:'tasks',name:'Tasks',columns:[{id:'title',name:'Title',type:'text'}]},rows:[],views:[shared],canCustomize:false}),
    personalViews:vi.fn().mockResolvedValue({revision:1,activeView:shared.id,views:[personal],computed:[personal],layouts:{}}),
    conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false,annotations:[]}),conversationNotifications:vi.fn().mockResolvedValue({items:[]}),
    templateShares:vi.fn().mockResolvedValue({shares:[],canManage:false}),versions:vi.fn().mockResolvedValue({versions:[]}),
  }
  await act(async()=>{tree=create(<AppView httpBase="https://api.example" orgId="team:one" sessionToken="one" onClose={()=>{}} api={state.api} appId="tasks" onBack={()=>{}} initialSection="data"/>);await new Promise(resolve=>setTimeout(resolve,0))})
  const tabs=tree!.root.findAllByProps({role:'tab'})
  expect(tabs).toHaveLength(2)
  expect(tabs[0].props['aria-selected']).toBe(true)
  expect(tabs[0].findAllByProps({className:'hx-personal-badge'})).toHaveLength(0)
  expect(tabs[1].props.disabled).toBe(true)
  expect(tabs[1].props.title).toContain('IDが重複')
  act(()=>tree!.root.findByProps({'aria-label':'新しいビュー'}).props.onClick())
  expect(tree!.root.findAllByType('button').some(node=>node.children.includes('個人ビューを削除'))).toBe(false)
})
test('a late personal-view read cannot restore a deleted view and focus returns to the shared tab',async()=>{
  vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn(),visibilityState:'visible'})
  const shared={id:'all',type:'table',name:'Shared',rows:[]},mine={id:'personal_mine',type:'table',name:'Mine',rows:[]}
  const initial={revision:1,activeView:mine.id,views:[mine],computed:[mine],layouts:{[mine.id]:{order:['title'],widths:{}}}}
  const deleted={revision:2,activeView:shared.id,views:[],computed:[],layouts:{}}
  let resolveOld!:(value:typeof initial)=>void
  const delayed=new Promise<typeof initial>(resolve=>{resolveOld=resolve})
  const focus=vi.fn()
  const appData={app:{id:'tasks',name:'Tasks',description:'',icon:'grid',tableId:'tasks',template:null,version:1,createdBy:'owner',channels:[],definition:{views:[shared]}},table:{id:'tasks',name:'Tasks',columns:[{id:'title',name:'Title',type:'text'}]},rows:[],views:[shared],canCustomize:true}
  const refreshedRow={id:'row_new',values:{title:'Refreshed row'},updatedAt:'2026-11-02T00:00:00Z'}
  state.api={
    app:vi.fn().mockResolvedValueOnce(appData).mockResolvedValueOnce({...appData,rows:[refreshedRow],views:[{...shared,rows:[refreshedRow]}]}),
    personalViews:vi.fn().mockResolvedValueOnce(initial).mockReturnValueOnce(delayed).mockResolvedValueOnce(deleted),savePersonalViews:vi.fn().mockResolvedValue(deleted),
    conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false,annotations:[]}),conversationNotifications:vi.fn().mockResolvedValue({items:[]}),
    templateShares:vi.fn().mockResolvedValue({shares:[],canManage:true}),versions:vi.fn().mockResolvedValue({versions:[]}),
  }
  await act(async()=>{tree=create(<AppView httpBase="https://api.example" orgId="team:one" sessionToken="one" onClose={()=>{}} api={state.api} appId="tasks" onBack={()=>{}} initialSection="data"/>,{createNodeMock:element=>element.props.role==='tab'?{focus}:null});await new Promise(resolve=>setTimeout(resolve,0))})
  act(()=>tree!.root.findByProps({'aria-label':'データを更新'}).props.onClick())
  act(()=>tree!.root.findByProps({'aria-label':'新しいビュー / 編集'}).props.onClick())
  const findButton=(label:string)=>tree!.root.findAllByType('button').find(node=>node.children.includes(label))!
  act(()=>findButton('個人ビューを削除').props.onClick())
  await act(async()=>{findButton('削除する').props.onClick();await Promise.resolve()})
  expect(state.api.savePersonalViews).toHaveBeenCalledOnce()
  expect(tree!.root.findAllByProps({role:'tab'})).toHaveLength(1)
  expect(focus).toHaveBeenCalled()
  await act(async()=>{resolveOld(initial);await delayed;await new Promise(resolve=>setTimeout(resolve,0))})
  expect(tree!.root.findAllByProps({role:'tab'})).toHaveLength(1)
  expect(tree!.root.findAllByProps({role:'tab'})[0].props['aria-selected']).toBe(true)
  expect(tree!.root.findAllByType('input').some(node=>node.props.value==='Refreshed row')).toBe(true)
})
test('a stale preferences read is recomputed before showing refreshed rows in a personal view',async()=>{
  vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn(),visibilityState:'visible'})
  const oldRow={id:'row_1',values:{title:'Old value'},updatedAt:'2026-11-01T00:00:00Z'}
  const newRow={id:'row_1',values:{title:'Updated value'},updatedAt:'2026-11-02T00:00:00Z'}
  const shared={id:'all',type:'table',name:'Shared',rows:[oldRow]},mine={id:'personal_mine',type:'table',name:'Mine',rows:[oldRow]}
  const initial={revision:1,activeView:mine.id,views:[mine],computed:[mine],layouts:{}}
  const saved={...initial,revision:2}
  const recomputed={...saved,computed:[{...mine,rows:[newRow]}]}
  let resolveOld!:(value:typeof initial)=>void
  const delayed=new Promise<typeof initial>(resolve=>{resolveOld=resolve})
  const appData={app:{id:'tasks',name:'Tasks',description:'',icon:'grid',tableId:'tasks',template:null,version:1,createdBy:'owner',channels:[],definition:{views:[shared]}},table:{id:'tasks',name:'Tasks',columns:[{id:'title',name:'Title',type:'text'}]},rows:[oldRow],views:[shared],canCustomize:true}
  state.api={
    app:vi.fn().mockResolvedValueOnce(appData).mockResolvedValueOnce({...appData,rows:[newRow],views:[{...shared,rows:[newRow]}]}),
    personalViews:vi.fn().mockResolvedValueOnce(initial).mockReturnValueOnce(delayed).mockResolvedValueOnce(recomputed),savePersonalViews:vi.fn().mockResolvedValue(saved),
    conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false,annotations:[]}),conversationNotifications:vi.fn().mockResolvedValue({items:[]}),
    templateShares:vi.fn().mockResolvedValue({shares:[],canManage:true}),versions:vi.fn().mockResolvedValue({versions:[]}),
  }
  await act(async()=>{tree=create(<AppView httpBase="https://api.example" orgId="team:one" sessionToken="one" onClose={()=>{}} api={state.api} appId="tasks" onBack={()=>{}} initialSection="data"/>);await new Promise(resolve=>setTimeout(resolve,0))})
  act(()=>tree!.root.findByProps({'aria-label':'データを更新'}).props.onClick())
  act(()=>tree!.root.findAllByType('button').find(node=>node.children.includes('フィールド'))!.props.onClick())
  await act(async()=>{tree!.root.findAllByType('button').find(node=>node.children.includes('保存'))!.props.onClick();await Promise.resolve()})
  await act(async()=>{resolveOld(initial);await delayed;await new Promise(resolve=>setTimeout(resolve,0))})
  expect(state.api.personalViews).toHaveBeenCalledTimes(3)
  expect(tree!.root.findAllByProps({role:'tab'}).find(node=>node.props['aria-selected'])?.children).toContain('Mine')
  expect(tree!.root.findAllByType('input').some(node=>node.props.value==='Updated value')).toBe(true)
  expect(tree!.root.findAllByType('input').some(node=>node.props.value==='Old value')).toBe(false)
})
test('a delayed deletion response cannot overwrite a newer cross-device revision or steal focus',async()=>{
  vi.stubGlobal('document',{addEventListener:vi.fn(),removeEventListener:vi.fn(),visibilityState:'visible'})
  const shared={id:'all',type:'table',name:'Shared',rows:[]},mine={id:'personal_mine',type:'table',name:'Mine',rows:[]}
  const initial={revision:1,activeView:mine.id,views:[mine],computed:[mine],layouts:{}}
  const newerView={...mine,name:'Other device'}
  const newer={revision:3,activeView:mine.id,views:[newerView],computed:[newerView],layouts:{}}
  let resolveDelete!:(value:unknown)=>void
  const delayed=new Promise(resolve=>{resolveDelete=resolve})
  const focus=vi.fn()
  state.api={
    app:vi.fn().mockResolvedValue({app:{id:'tasks',name:'Tasks',description:'',icon:'grid',tableId:'tasks',template:null,version:1,createdBy:'owner',channels:[],definition:{views:[shared]}},table:{id:'tasks',name:'Tasks',columns:[{id:'title',name:'Title',type:'text'}]},rows:[],views:[shared],canCustomize:true}),
    personalViews:vi.fn().mockResolvedValueOnce(initial).mockResolvedValueOnce(newer),savePersonalViews:vi.fn().mockReturnValue(delayed),
    conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false,annotations:[]}),conversationNotifications:vi.fn().mockResolvedValue({items:[]}),
    templateShares:vi.fn().mockResolvedValue({shares:[],canManage:true}),versions:vi.fn().mockResolvedValue({versions:[]}),
  }
  await act(async()=>{tree=create(<AppView httpBase="https://api.example" orgId="team:one" sessionToken="one" onClose={()=>{}} api={state.api} appId="tasks" onBack={()=>{}} initialSection="data"/>,{createNodeMock:element=>element.props.role==='tab'?{focus}:null});await new Promise(resolve=>setTimeout(resolve,0))})
  act(()=>tree!.root.findByProps({'aria-label':'新しいビュー / 編集'}).props.onClick())
  const findButton=(label:string)=>tree!.root.findAllByType('button').find(node=>node.children.includes(label))!
  act(()=>findButton('個人ビューを削除').props.onClick())
  act(()=>findButton('削除する').props.onClick())
  await act(async()=>{tree!.root.findByProps({'aria-label':'データを更新'}).props.onClick();await new Promise(resolve=>setTimeout(resolve,0))})
  await act(async()=>{resolveDelete({revision:2,activeView:'all',views:[],computed:[],layouts:{}});await delayed})
  expect(tree!.root.findAllByProps({role:'tab'}).some(node=>node.children.includes('Other device'))).toBe(true)
  expect(tree!.root.findAllByProps({role:'tab'}).find(node=>node.props['aria-selected'])?.children).toContain('Other device')
  expect(focus).not.toHaveBeenCalled()
})
test('returning to a visible app reloads another device’s personal view changes',async()=>{
  const windowHandlers=new Map<string,()=>void>(),documentHandlers=new Map<string,()=>void>()
  vi.stubGlobal('window',{addEventListener:(name:string,fn:()=>void)=>windowHandlers.set(name,fn),removeEventListener:(name:string)=>windowHandlers.delete(name)})
  const documentStub={visibilityState:'visible',activeElement:null,querySelector:()=>null,addEventListener:(name:string,fn:()=>void)=>documentHandlers.set(name,fn),removeEventListener:(name:string)=>documentHandlers.delete(name)}
  vi.stubGlobal('document',documentStub)
  const shared={id:'all',type:'table',name:'Shared',rows:[]},mine={id:'personal_new',type:'table',name:'From another device',rows:[]}
  const initial={revision:0,activeView:'all',views:[],computed:[],layouts:{}},newer={revision:1,activeView:mine.id,views:[mine],computed:[mine],layouts:{}}
  state.api={
    app:vi.fn().mockResolvedValue({app:{id:'tasks',name:'Tasks',description:'',icon:'grid',tableId:'tasks',template:null,version:1,createdBy:'owner',channels:[],definition:{views:[shared]}},table:{id:'tasks',name:'Tasks',columns:[{id:'title',name:'Title',type:'text'}]},rows:[],views:[shared],canCustomize:true}),
    personalViews:vi.fn().mockResolvedValueOnce(initial).mockResolvedValue(newer),
    conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false,annotations:[]}),conversationNotifications:vi.fn().mockResolvedValue({items:[]}),
    templateShares:vi.fn().mockResolvedValue({shares:[],canManage:true}),versions:vi.fn().mockResolvedValue({versions:[]}),
  }
  await act(async()=>{tree=create(<AppView httpBase="https://api.example" orgId="team:one" sessionToken="one" onClose={()=>{}} api={state.api} appId="tasks" onBack={()=>{}} initialSection="data"/>);await new Promise(resolve=>setTimeout(resolve,0))})
  await act(async()=>{windowHandlers.get('focus')!();await new Promise(resolve=>setTimeout(resolve,0))})
  expect(state.api.personalViews).toHaveBeenCalledTimes(2)
  expect(tree!.root.findAllByProps({role:'tab'}).find(node=>node.props['aria-selected'])?.children).toContain('From another device')
  documentStub.visibilityState='hidden'
  await act(async()=>{documentHandlers.get('visibilitychange')!();await Promise.resolve()})
  expect(state.api.personalViews).toHaveBeenCalledTimes(2)
  documentStub.visibilityState='visible'
  await act(async()=>{documentHandlers.get('visibilitychange')!();await new Promise(resolve=>setTimeout(resolve,0))})
  expect(state.api.personalViews).toHaveBeenCalledTimes(3)
})
test('an automatic refresh waits if editing begins while its read is in flight',async()=>{
  const windowHandlers=new Map<string,()=>void>(),documentHandlers=new Map<string,()=>void>()
  vi.stubGlobal('window',{addEventListener:(name:string,fn:()=>void)=>windowHandlers.set(name,fn),removeEventListener:(name:string)=>windowHandlers.delete(name)})
  vi.stubGlobal('document',{visibilityState:'visible',activeElement:null,querySelector:()=>null,addEventListener:(name:string,fn:()=>void)=>documentHandlers.set(name,fn),removeEventListener:(name:string)=>documentHandlers.delete(name)})
  let editing=false
  const main={toggleAttribute:vi.fn(),querySelector:()=>editing?{}:null,contains:()=>false}
  const shared={id:'all',type:'table',name:'Shared',rows:[]},mine={id:'personal_new',type:'table',name:'Other device',rows:[]}
  const initial={revision:0,activeView:'all',views:[],computed:[],layouts:{}},newer={revision:1,activeView:'all',views:[mine],computed:[mine],layouts:{}}
  let resolveRead!:(value:typeof newer)=>void
  const delayed=new Promise<typeof newer>(resolve=>{resolveRead=resolve})
  state.api={
    app:vi.fn().mockResolvedValue({app:{id:'tasks',name:'Tasks',description:'',icon:'grid',tableId:'tasks',template:null,version:1,createdBy:'owner',channels:[],definition:{views:[shared]}},table:{id:'tasks',name:'Tasks',columns:[{id:'title',name:'Title',type:'text'}]},rows:[],views:[shared],canCustomize:true}),
    personalViews:vi.fn().mockResolvedValueOnce(initial).mockReturnValueOnce(delayed).mockResolvedValueOnce(newer),
    conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false,annotations:[]}),conversationNotifications:vi.fn().mockResolvedValue({items:[]}),
    templateShares:vi.fn().mockResolvedValue({shares:[],canManage:true}),versions:vi.fn().mockResolvedValue({versions:[]}),
  }
  await act(async()=>{tree=create(<AppView httpBase="https://api.example" orgId="team:one" sessionToken="one" onClose={()=>{}} api={state.api} appId="tasks" onBack={()=>{}} initialSection="data"/>,{createNodeMock:element=>element.props.className==='hx-app-main'?main:null});await new Promise(resolve=>setTimeout(resolve,0))})
  act(()=>windowHandlers.get('focus')!())
  editing=true
  act(()=>tree!.root.findAllByType('button').find(node=>node.children.includes('フィールド'))!.props.onClick())
  act(()=>tree!.root.findByProps({'aria-label':'Titleの列幅'}).props.onChange({target:{value:'320'}}))
  await act(async()=>{resolveRead(newer);await delayed;await new Promise(resolve=>setTimeout(resolve,0))})
  expect(tree!.root.findByProps({'aria-label':'Titleの列幅'}).props.value).toBe(320)
  expect(tree!.root.findAllByProps({role:'tab'})).toHaveLength(1)
  act(()=>tree!.root.findAllByType('button').find(node=>node.children.includes('フィールド'))!.props.onClick())
  editing=false
  await act(async()=>{documentHandlers.get('click')!();await new Promise(resolve=>setTimeout(resolve,0))})
  expect(state.api.personalViews).toHaveBeenCalledTimes(3)
  expect(tree!.root.findAllByProps({role:'tab'})).toHaveLength(2)
})
test('an automatic refresh does not overwrite an inline edit while its save is pending',async()=>{
  const windowHandlers=new Map<string,()=>void>(),documentHandlers=new Map<string,()=>void>()
  vi.stubGlobal('window',{addEventListener:(name:string,fn:()=>void)=>windowHandlers.set(name,fn),removeEventListener:(name:string)=>windowHandlers.delete(name)})
  vi.stubGlobal('document',{visibilityState:'visible',activeElement:null,querySelector:()=>null,addEventListener:(name:string,fn:()=>void)=>documentHandlers.set(name,fn),removeEventListener:(name:string)=>documentHandlers.delete(name)})
  const main={toggleAttribute:vi.fn(),querySelector:()=>null,contains:()=>false}
  const oldRow={id:'row_1',values:{title:'Old'},updatedAt:'2026-11-01T00:00:00Z'}
  const remoteRow={...oldRow,values:{title:'Remote'}},savedRow={...oldRow,values:{title:'User edit'}}
  const shared={id:'all',type:'table',name:'Shared',rows:[oldRow]},initial={revision:0,activeView:'all',views:[],computed:[],layouts:{}}
  let resolveRead!:(value:typeof initial)=>void,resolveWrite!:()=>void
  const delayedRead=new Promise<typeof initial>(resolve=>{resolveRead=resolve}),delayedWrite=new Promise<void>(resolve=>{resolveWrite=resolve})
  const data=(row:typeof oldRow)=>({app:{id:'tasks',name:'Tasks',description:'',icon:'grid',tableId:'tasks',template:null,version:1,createdBy:'owner',channels:[],definition:{views:[shared]}},table:{id:'tasks',name:'Tasks',columns:[{id:'title',name:'Title',type:'text'}]},rows:[row],views:[{...shared,rows:[row]}],canCustomize:true})
  state.api={
    app:vi.fn().mockResolvedValueOnce(data(oldRow)).mockResolvedValueOnce(data(remoteRow)).mockResolvedValue(data(savedRow)),
    personalViews:vi.fn().mockResolvedValueOnce(initial).mockReturnValueOnce(delayedRead).mockResolvedValue(initial),updateRow:vi.fn().mockReturnValue(delayedWrite),
    conversation:vi.fn().mockResolvedValue({messages:[],hasMore:false,annotations:[]}),conversationNotifications:vi.fn().mockResolvedValue({items:[]}),
    templateShares:vi.fn().mockResolvedValue({shares:[],canManage:true}),versions:vi.fn().mockResolvedValue({versions:[]}),
  }
  await act(async()=>{tree=create(<AppView httpBase="https://api.example" orgId="team:one" sessionToken="one" onClose={()=>{}} api={state.api} appId="tasks" onBack={()=>{}} initialSection="data"/>,{createNodeMock:element=>element.props.className==='hx-app-main'?main:null});await new Promise(resolve=>setTimeout(resolve,0))})
  act(()=>windowHandlers.get('focus')!())
  const input=()=>tree!.root.findAllByType('input').find(node=>node.props['aria-label']==='Title')!
  act(()=>input().props.onChange({target:{value:'User edit'}}))
  act(()=>input().props.onBlur())
  await act(async()=>{resolveRead(initial);await delayedRead;await new Promise(resolve=>setTimeout(resolve,0))})
  expect(input().props.value).toBe('User edit')
  await act(async()=>{resolveWrite();await delayedWrite;await new Promise(resolve=>setTimeout(resolve,0))})
  expect(input().props.value).toBe('User edit')
})
test('read-only app viewers do not get room-link controls in settings', async () => {
  state.api = {
    app: vi.fn().mockResolvedValue({
      app: { id: 'readonly', name: 'Read only', description: '', icon: '📋', tableId: 'tasks', template: null, version: 1, createdBy: 'owner', channels: [], definition: { views: [] } },
      table: { id: 'tasks', orgId: 'team:one', name: 'Tasks', columns: [{ id: 'title', name: 'Title', type: 'text' }] },
      rows: [], views: [{ id: 'all', type: 'table', name: 'All', rows: [] }], canCustomize: false,
    }),
    personalViews: vi.fn().mockResolvedValue({ revision: 0, views: [], computed: [], layouts: {} }),
    conversation: vi.fn().mockResolvedValue({ messages: [], hasMore: false, annotations: [] }),
    conversationNotifications: vi.fn().mockResolvedValue({ items: [] }),
    templateShares: vi.fn().mockResolvedValue({ shares: [], canManage: false }),
    versions: vi.fn().mockResolvedValue({ versions: [] }),
  }
  await act(async () => {
    tree = create(<AppView httpBase="https://api.example" orgId="team:one" sessionToken="one" onClose={() => {}} api={state.api} appId="readonly" onBack={() => {}} initialSection="settings" />)
    await new Promise(resolve => setTimeout(resolve, 0))
  })
  expect(tree!.root.findAllByProps({ 'aria-label': 'Room' })).toHaveLength(0)
  expect(tree!.root.findAllByType('button').some(node => node.children.includes('Link'))).toBe(false)
  expect(JSON.stringify(tree!.toJSON())).not.toContain('Link it to a room')
})
test('late completion retains another destination and a revised prompt', async () => {
  const { completion } = await start()
  act(() => tree!.root.findByType('textarea').props.onChange({ target: { value: 'Next request' } }))
  location.hash = '#/apps/another/team%3Aone'
  await act(async () => { finish({ app: { id: 'created' }, source: 'template' }); await completion })
  expect(location.hash).toBe('#/apps/another/team%3Aone')
  expect(tree!.root.findByType('textarea').props.value).toBe('Next request')
})
test('completion from an unmounted account cannot navigate the new account', async () => {
  const { completion } = await start()
  act(() => tree!.unmount()); tree = undefined
  location.hash = '#/apps/other/team%3Atwo'
  await act(async () => { finish({ app: { id: 'created' }, source: 'template' }); await completion })
  expect(location.hash).toBe('#/apps/other/team%3Atwo')
})

test('a shared template can be inspected and imported from its link', async () => {
  state.api = {
    sharedTemplate: vi.fn().mockResolvedValue({ expiresAt: '2026-11-07T00:00:00Z', snapshot: {
      format: 1, app: { name: 'Pipeline', description: 'Deals by stage', icon: '📊' }, version: 2, tableName: 'Deals',
      columns: [{ name: 'Company', type: 'text' }, { name: 'Stage', type: 'select', options: ['Lead', 'Won'] }],
      definition: { views: [{ id: 'board', type: 'board', name: 'Stages', groupBy: 'stage' }] },
    } }),
    importSharedTemplate: vi.fn().mockResolvedValue({ app: { id: 'imported' }, sourceVersion: 2 }),
  }
  await act(async () => { tree = create(<HarnessTemplateImport httpBase="https://api.example" orgId="team:one" sessionToken="one" token={'tpl_' + 'ab'.repeat(32)} onClose={() => {}} />) })
  expect(tree!.root.findAllByType('h2')[0].children).toContain('Pipeline')
  await act(async () => { tree!.root.findAllByType('button').find(node => node.children.includes('Import template'))!.props.onClick() })
  expect(state.api.importSharedTemplate).toHaveBeenCalledWith('tpl_' + 'ab'.repeat(32), undefined)
  expect(tree!.root.findAllByType('strong').some(node => node.children.includes('Template imported.'))).toBe(true)
  await act(async () => { tree!.root.findAllByType('button').find(node => node.children.includes('Open in Apps'))!.props.onClick() })
  expect(location.hash).toBe('#/apps/imported/team%3Aone')
})
