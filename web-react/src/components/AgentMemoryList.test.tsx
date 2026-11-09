import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { AgentMemoryList, MemoryKindSelect } from './AgentMemoryList'
vi.mock('../utils/i18n', () => ({ useT: () => (text: string, values?: Record<string, string | number>) =>
  Object.entries(values || {}).reduce((result, [key, value]) => result.replaceAll(`{${key}}`, String(value)), text) }))
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

test('personal memory owners can manage only their personal entries without gaining shared edit rights',()=>{
 const shared={...memories[1],id:'shared',scope:'shared' as const}
 const personal={...memories[1],id:'personal',scope:'person' as const,isOwner:true}
 const edit=vi.fn(),forget=vi.fn(),review=vi.fn(),convert=vi.fn(),promote=vi.fn();let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<AgentMemoryList memories={[shared,personal]} canEdit={false} busy={false} onForget={forget} onEdit={edit} onReview={review} onConvert={convert} onPromote={promote}/> )})
 const buttons=tree.root.findAllByType('button')
 expect(buttons.map(button=>button.children.join(''))).toEqual(['Review memory','Request shared copy','Edit memory','Forget'])
 act(()=>buttons.find(button=>button.children.includes('Request shared copy'))!.props.onClick())
 expect(promote).toHaveBeenCalledWith(personal)
 act(()=>buttons.find(button=>button.children.includes('Edit memory'))!.props.onClick())
 expect(edit).toHaveBeenCalledWith(personal)
 expect(convert).not.toHaveBeenCalled()
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
  await api.remember('agent','Personal','', 'preference','personal')
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toMatchObject({text:'Personal',scope:'personal'})
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
  await api.rememberEntry('a',{...entry,scope:'personal'})
  expect(JSON.parse(fetcher.mock.calls[1][1].body)).toMatchObject({scope:'personal',body:entry.body})
  await api.updateMemory('a',{...memories[0],version:7},entry,'')
  expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({orgId:'org',...entry,id:'1',expectedVersion:7,channel:''})
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

test('remote memory search submits query and kind without filtering a partial loaded page',()=>{
 const search=vi.fn();let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<AgentMemoryList memories={memories} canEdit={false} busy={false} onForget={vi.fn()} onSearch={search}/>)})
 act(()=>tree.root.findByProps({'aria-label':'Search memories'}).props.onChange({target:{value:' older policy '}}))
 act(()=>tree.root.findByProps({'aria-label':'Filter memory type'}).props.onChange({target:{value:'reference'}}))
 expect(tree.root.findAllByProps({className:'memory-text'})).toHaveLength(3)
 act(()=>tree.root.findByType('form').props.onSubmit({preventDefault:vi.fn()}))
 expect(search).toHaveBeenCalledWith('older policy','reference')
 act(()=>tree.unmount())
})

test('pending remote memory search shows loading rather than an empty result and cannot resubmit',()=>{
 const search=vi.fn();let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<AgentMemoryList memories={[]} canEdit={false} busy loading onForget={vi.fn()} onSearch={search}/>)})
 expect(JSON.stringify(tree.toJSON())).toContain('Loading…')
 expect(JSON.stringify(tree.toJSON())).not.toContain('No memories yet.')
 act(()=>tree.root.findByType('form').props.onSubmit({preventDefault:vi.fn()}))
 expect(search).not.toHaveBeenCalled()
 act(()=>tree.update(<AgentMemoryList memories={[]} canEdit={false} busy={false} loading={false} onForget={vi.fn()} onSearch={search}/>))
 expect(JSON.stringify(tree.toJSON())).not.toContain('Loading…')
 act(()=>tree.unmount())
})

test('review details distinguish checked content from later changes and restrict review actions',()=>{
 let tree!:ReturnType<typeof create>;const review=vi.fn()
 const checked={...memories[0],review:{version:1,evidence:'Verified with owner',by:'owner',at:'2026-10-24T00:00:00Z',current:true}}
 act(()=>{tree=create(<AgentMemoryList memories={[checked]} canEdit busy={false} onForget={vi.fn()} onReview={review}/>)})
 expect(tree.root.findByType('summary').children).toEqual(['Memory reviewed'])
 act(()=>tree.root.findAllByType('button').find(b=>b.children.includes('Review memory'))!.props.onClick())
 expect(review).toHaveBeenCalledWith(checked)
 act(()=>tree.update(<AgentMemoryList memories={[{...checked,review:{...checked.review,current:false}}]} canEdit={false} busy={false} onForget={vi.fn()} onReview={review}/>))
 expect(tree.root.findByType('summary').children).toEqual(['Changed since review'])
 expect(tree.root.findAllByType('button')).toHaveLength(0)
 expect(tree.root.findByType('time').props.dateTime).toBe(checked.review.at)
 act(()=>tree.unmount())
})

test('empty saved search distinguishes no matches from an agent with no memories',()=>{
 let tree!:ReturnType<typeof create>
 const props={memories:[],canEdit:false,busy:false,onForget:vi.fn(),onSearch:vi.fn()}
 act(()=>{tree=create(<AgentMemoryList {...props}/> )})
 expect(JSON.stringify(tree.toJSON())).toContain('No memories yet.')
 act(()=>tree.root.findByProps({'aria-label':'Search memories'}).props.onChange({target:{value:'Not submitted'}}))
 expect(JSON.stringify(tree.toJSON())).toContain('No memories yet.')
 act(()=>tree.update(<AgentMemoryList {...props} filtered/>))
 expect(JSON.stringify(tree.toJSON())).toContain('No memories match these filters.')
 expect(JSON.stringify(tree.toJSON())).not.toContain('No memories yet.')
 act(()=>tree.update(<AgentMemoryList {...props} filtered loading/>))
 expect(JSON.stringify(tree.toJSON())).not.toContain('No memories match these filters.')
 act(()=>tree.unmount())
})

test('memory provenance is available without exposing the source message body',()=>{
 let tree!:ReturnType<typeof create>
 const entry={id:'provenance',text:'Retain this preference',source:'person',createdAt:'2026-10-20',sourceChannel:'b:ops',sourceMessageId:'msg_source_1',sourceThreadId:'msg_root_1'}
 act(()=>{tree=create(<AgentMemoryList memories={[entry]} canEdit={false} busy={false} onForget={vi.fn()}/> )})
 const json=JSON.stringify(tree.toJSON())
 expect(json).toContain('Source reference')
 expect(json).toContain('msg_source_1')
 expect(json).toContain('msg_root_1')
 expect(json).toContain('b:ops')
 expect(json).not.toContain('secret source text')
 act(()=>tree.unmount())
})

test('shared memory shows its creator and most recent editor',()=>{
 let tree!:ReturnType<typeof create>
 const entry={...memories[0],createdByName:'Memory Creator',updatedByName:'Memory Editor',updatedAt:'2026-10-28T12:00:00Z'}
 act(()=>{tree=create(<AgentMemoryList memories={[entry]} canEdit={false} busy={false} onForget={vi.fn()}/> )})
 const json=JSON.stringify(tree.toJSON())
 expect(json).toContain('Created by Memory Creator')
 expect(json).toContain('Last updated by Memory Editor')
 act(()=>tree.unmount())
})
