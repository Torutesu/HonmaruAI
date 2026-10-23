import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { AgentMemoryList, MemoryKindSelect } from './AgentMemoryList'
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
const memories = [
  { id: '1', text: 'Weekly report', source: 'person', createdAt: '2026-10-20', kind: 'preference', channel: 'dm:a|b' },
  { id: '2', text: 'Weekly budget', source: 'person', createdAt: '2026-10-20', kind: 'reference' },
  { id: '3', text: 'Legacy note', source: 'person', createdAt: '2026-10-20' },
]
test('search and kind filter intersect; legacy entries are context and scope remains visible', () => {
  let tree!: ReturnType<typeof create>;const forget=vi.fn()
  act(() => { tree=create(<AgentMemoryList memories={memories} canEdit busy={false} onForget={forget}/>) })
  const texts=()=>tree.root.findAllByProps({className:'memory-text'}).map(x=>x.children.join(''))
  act(()=>tree.root.findByProps({'aria-label':'Search memories'}).props.onChange({target:{value:'WEEKLY'}}))
  expect(texts()).toEqual(['Weekly report','Weekly budget'])
  act(()=>tree.root.findByProps({'aria-label':'Filter memory type'}).props.onChange({target:{value:'preference'}}))
  expect(texts()).toEqual(['Weekly report'])
  expect(JSON.stringify(tree.toJSON())).toContain('Conversation memory')
  act(()=>tree.root.findByType('button').props.onClick());expect(forget).toHaveBeenCalledWith(memories[0])
  act(()=>tree.root.findByProps({'aria-label':'Search memories'}).props.onChange({target:{value:''}}))
  act(()=>tree.root.findByProps({'aria-label':'Filter memory type'}).props.onChange({target:{value:'context'}}))
  expect(texts()).toEqual(['Legacy note'])
  expect(JSON.stringify(tree.toJSON())).toContain('Agent memory')
  act(()=>tree.update(<AgentMemoryList memories={memories} canEdit={false} busy={false} onForget={forget}/>))
  expect(tree.root.findAllByType('button')).toHaveLength(0)
  act(()=>tree.unmount())
})
test('all four memory kinds can be selected',()=>{
 const change=vi.fn();let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<MemoryKindSelect value="context" onChange={change}/>)});
 expect(tree.root.findAllByType('option').map(o=>o.props.value)).toEqual(['preference','feedback','reference','context'])
 act(()=>tree.root.findByType('select').props.onChange({target:{value:'feedback'}}));expect(change).toHaveBeenCalledWith('feedback')
 act(()=>tree.unmount())
})

test('memory creation sends selected kind and conversation without changing legacy default', async()=>{
 const {harnessApi}=await import('../utils/harness')
 const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({memory:{}})})
 vi.stubGlobal('fetch',fetcher)
 try {
  const api=harnessApi('https://example.test','org','test')
  await api.remember('agent','A preference','dm:other','preference')
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({orgId:'org',text:'A preference',channel:'dm:other',kind:'preference'})
  await api.remember('agent','Legacy')
  expect(JSON.parse(fetcher.mock.calls[1][1].body).kind).toBe('context')
 } finally {vi.unstubAllGlobals()}
})

test('structured entries search title, description and full body and preserve edit identity',()=>{
 const entry={...memories[0],title:'Invoice procedure',description:'Accounting',body:'First\n\nSecond detailed step',version:2}
 const edit=vi.fn();let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<AgentMemoryList memories={[entry]} canEdit busy={false} onForget={vi.fn()} onEdit={edit}/>)})
 act(()=>tree.root.findByProps({'aria-label':'Search memories'}).props.onChange({target:{value:'accounting'}}))
 expect(tree.root.findByType('summary').children).toEqual(['Invoice procedure'])
 act(()=>tree.root.findAllByType('button').find(b=>b.children.includes('Edit memory'))!.props.onClick())
 expect(edit).toHaveBeenCalledWith(entry)
 act(()=>tree.root.findByProps({'aria-label':'Search memories'}).props.onChange({target:{value:'detailed'}}))
 expect(tree.root.findByProps({className:'memory-text'}).children.join('')).toBe(entry.body)
 act(()=>tree.unmount())
})

test('structured memory API preserves full fields and sends the loaded version and exact scope',async()=>{
 const {harnessApi}=await import('../utils/harness')
 const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({memory:{}})})
 vi.stubGlobal('fetch',fetcher)
 try {
  const api=harnessApi('https://example.test','org','session'),entry={title:'Policy',description:'Team rules',body:'Line one\n\nLine two',kind:'reference' as const}
  await api.rememberEntry('a',entry,'b:ops')
  expect(JSON.parse(fetcher.mock.calls[0][1].body)).toEqual({orgId:'org',...entry,channel:'b:ops'})
  await api.updateMemory('a',{...memories[0],version:7},entry,'')
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({orgId:'org',...entry,id:'1',expectedVersion:7,channel:''})
 } finally {vi.unstubAllGlobals()}
})

test('memory paging carries the exact conversation and opaque continuation', async()=>{
 const {harnessApi}=await import('../utils/harness')
 const fetcher=vi.fn().mockResolvedValue({ok:true,json:async()=>({memories:[],nextCursor:null,canEdit:false})})
 vi.stubGlobal('fetch',fetcher)
 try {
  await harnessApi('https://example.test','workspace','session').memoryPage('agent','dm:a|b','["scope","time","id"]')
  const url=new URL(fetcher.mock.calls[0][0])
  expect(url.searchParams.get('orgId')).toBe('workspace')
  expect(url.searchParams.get('channel')).toBe('dm:a|b')
  expect(url.searchParams.get('paged')).toBe('1')
  expect(url.searchParams.get('cursor')).toBe('["scope","time","id"]')
 } finally {vi.unstubAllGlobals()}
})
