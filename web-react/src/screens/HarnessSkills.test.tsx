import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { HarnessSkills } from './HarnessAgents'
const state = vi.hoisted(() => ({ api: null as any }))
vi.mock('./HarnessShared', async importOriginal => ({ ...(await importOriginal<any>()), useApi: () => state.api }))
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
const props = { httpBase: 'https://example.test', orgId: 'one', sessionToken: 'test', onClose: () => {} }
const draft = { name: 'Review', description: 'Review changes', body: 'Check permissions.', metadata: { license: 'MIT' } }
function api() { return { skills: vi.fn().mockResolvedValue({ skills: [] }), previewSkillImport: vi.fn().mockResolvedValue({ draft }), createSkill: vi.fn().mockResolvedValue({}), skillFiles: vi.fn().mockResolvedValue({files:[]}), readSkillFile: vi.fn(), updateSkill: vi.fn().mockResolvedValue({}) } }
test('import is reviewed before private save and preserves metadata', async () => {
  state.api = api(); let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<HarnessSkills {...props} />) })
  await act(async () => { tree.root.findByProps({ type: 'file', accept: '.md,.zip,text/markdown,application/zip' }).props.onChange({ target: { files: [{ name: 'SKILL.md', size: 100, text: async () => 'markdown' }], value: 'file' } }) })
  expect(state.api.createSkill).not.toHaveBeenCalled()
  expect(tree.root.findByProps({ 'aria-label': 'Skill name' }).props.value).toBe('Review')
  await act(async () => { tree.root.findAllByType('button').find(b => b.children.includes('Save'))!.props.onClick() })
  expect(state.api.createSkill).toHaveBeenCalledWith({ ...draft, visibility: 'private' })
  act(() => tree.unmount())
})
test('late preview from the previous workspace never opens a draft', async () => {
  state.api = api(); let resolve!: (value: any) => void
  state.api.previewSkillImport.mockReturnValue(new Promise(r => { resolve = r }))
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<HarnessSkills {...props} />) })
  await act(async () => { tree.root.findByProps({ type: 'file', accept: '.md,.zip,text/markdown,application/zip' }).props.onChange({ target: { files: [{ name: 'SKILL.md', size: 100, text: async () => 'markdown' }], value: 'file' } }) })
  state.api = api()
  await act(async () => { tree.update(<HarnessSkills {...props} orgId="two" />) })
  await act(async () => { resolve({ draft }) })
  expect(tree.root.findAllByProps({ 'aria-label': 'Skill name' })).toHaveLength(0)
  expect(state.api.createSkill).not.toHaveBeenCalled()
  act(() => tree.unmount())
})
test('late list failures from an old session cannot replace the current skills or error state', async () => {
  state.api = api()
  let reject!: (reason: Error) => void
  state.api.skills.mockReturnValue(new Promise((_, fail) => { reject = fail }))
  let tree!: ReturnType<typeof create>
  await act(async () => { tree = create(<HarnessSkills {...props} />) })
  state.api = api()
  state.api.skills.mockResolvedValue({ skills: [{ id: 'new', name: 'Current skill', description: 'Current session', body: '', visibility: 'private' }] })
  await act(async () => { tree.update(<HarnessSkills {...props} sessionToken="new-session" />) })
  await act(async () => { reject(new Error('Previous session error')) })
  expect(JSON.stringify(tree.toJSON())).toContain('Current skill')
  expect(JSON.stringify(tree.toJSON())).not.toContain('Previous session error')
  act(() => tree.unmount())
})

test('derived skills describe inherited access instead of offering a misleading private sharing selector',async()=>{
 state.api=api();state.api.skills.mockResolvedValue({skills:[{id:'derived',...draft,createdBy:'owner',visibility:'private',canShare:false,sourceScope:{agentId:'agent',channel:'b:source'}}]})
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<HarnessSkills {...props}/>)})
 expect(JSON.stringify(tree.toJSON())).toContain('Restricted to source conversation and agent')
 expect(tree.root.findAllByProps({'aria-label':'Skill visibility'})).toHaveLength(0)
 act(()=>tree.unmount())
})

test('support files can be edited, added and removed with a stale-version guard', async () => {
  const skill = { id:'skill-1', ...draft, createdBy:'owner', visibility:'private', canEdit:true, updatedAt:'2026-11-14T00:00:00.000Z' }
  state.api=api()
  state.api.skills.mockResolvedValue({skills:[skill]})
  state.api.skillFiles.mockResolvedValue({files:[{path:'references/guide.md',size:8},{path:'image.bin',size:3}]})
  state.api.readSkillFile.mockImplementation(async(_id:string,path:string)=>path.endsWith('.md')?new TextEncoder().encode('Old text'):new Uint8Array([0,255,128]))
  let tree!:ReturnType<typeof create>
  await act(async()=>{tree=create(<HarnessSkills {...props}/>)})
  await act(async()=>{tree.root.findAllByType('button').find(button=>button.children.includes('Edit'))!.props.onClick()})
  expect(tree.root.findAllByProps({'aria-label':'File path'})).toHaveLength(2)
  const content=tree.root.findByProps({'aria-label':'File contents'})
  act(()=>content.props.onChange({target:{value:'Updated text'}}))
  await act(async()=>{await tree.root.findByProps({'aria-label':'Add support files'}).props.onChange({target:{files:[{name:'new.txt',size:9,arrayBuffer:async()=>new TextEncoder().encode('new guide').buffer}],value:'file'}})})
  expect(tree.root.findAllByProps({'aria-label':'File path'}).map(node=>node.props.value)).toEqual(['references/guide.md','image.bin','new.txt'])
  await act(async()=>{tree.root.findAllByProps({'aria-label':'Remove support file'})[1].props.onClick()})
  await act(async()=>{tree.root.findAllByType('button').find(button=>button.children.includes('Save'))!.props.onClick()})
  const [id,payload]=state.api.updateSkill.mock.calls[0]
  expect(id).toBe('skill-1')
  expect(payload.expectedUpdatedAt).toBe(skill.updatedAt)
  expect(payload.files.map((file:any)=>file.path)).toEqual(['references/guide.md','new.txt'])
  const byPath=Object.fromEntries(payload.files.map((file:any)=>[file.path,atob(file.base64)]))
  expect(byPath['references/guide.md']).toBe('Updated text')
  expect(byPath['new.txt']).toBe('new guide')
  act(()=>tree.unmount())
})
