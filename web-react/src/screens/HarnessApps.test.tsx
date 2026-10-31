import React from 'react'
import { act, create } from 'react-test-renderer'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { HarnessApps, HarnessTemplateImport, newAppRecordLabel } from './Harness'

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
  expect(newAppRecordLabel('Sales CRM','Sales CRM')).toBe('新規レコード')
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
  }
})
afterEach(() => { if (tree) act(() => tree!.unmount()); tree = undefined; vi.unstubAllGlobals() })
const button = (label: string) => tree!.root.findAllByType('button').find(node => node.props.children === label)!
test('Remote MCP server settings are available from the Harness Apps library', async () => {
  await act(async () => { tree = create(<HarnessApps httpBase="https://api.example" orgId="team:one" sessionToken="one" onClose={() => {}} />) })
  expect(tree!.root.findByProps({ id: 'remote-mcp-title' }).children).toContain('Remote MCP servers')
  expect(tree!.root.findAllByProps({ className: 'remote-mcp-empty' }).some(node => node.children.includes('No Remote MCP servers connected yet.'))).toBe(true)
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
test('room generation opens the saved source route rather than a detached app panel',async()=>{
 const {completion}=await start('Build a tracker for #general')
 await act(async()=>{finish({app:{id:'created'},source:'template'});await completion})
 expect(state.api.generate).toHaveBeenCalledWith('Build a tracker for #general','b:general',expect.objectContaining({captureSource:true}))
 expect(location.hash).toBe('#/apps/created/team%3Aone?source=1')
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
