import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { AgentSkillCatalog } from './AgentSkillCatalog'
import type { Skill } from '../utils/harness'
vi.mock('../utils/i18n',()=>({useT:()=> (s:string)=>s}))
const a={id:'a',name:'Review',description:'Check releases',body:'Review',createdBy:'alice'} as Skill
const b={id:'b',name:'Report',description:'Weekly summary',body:'Report',createdBy:'bob'} as Skill
const nodes=()=>({showModal:vi.fn(),close:vi.fn(),focus:vi.fn(),querySelector:vi.fn()})
test('catalog separates installed skills and searches available descriptions and authors',async()=>{
 let tree!:ReturnType<typeof create>;const toggle=vi.fn().mockResolvedValue(undefined)
 act(()=>{tree=create(<AgentSkillCatalog skills={[a,b]} installed={[a]} canEdit onToggle={toggle}/>,{createNodeMock:nodes})})
 expect(tree.root.findAllByType('strong').map(n=>n.children.join(''))).toEqual(['Review'])
 act(()=>tree.root.findAllByType('button').find(n=>n.children.includes('Add skills'))!.props.onClick())
 const dialog=tree.root.findByType('dialog')
 expect(dialog.findAllByType('strong').map(n=>n.children.join(''))).toEqual(['Report'])
 act(()=>dialog.findByType('input').props.onChange({target:{value:'BOB'}}))
 expect(dialog.findAllByType('strong')).toHaveLength(1)
 await act(async()=>{await dialog.findAllByType('button').find(n=>n.children.includes('Install'))!.props.onClick()})
 expect(toggle).toHaveBeenCalledWith('b',true)
 act(()=>dialog.findByType('input').props.onChange({target:{value:''}}))
 act(()=>dialog.findAllByProps({role:'tab'})[1].props.onClick())
 expect(dialog.findAllByType('strong').map(n=>n.children.join(''))).toEqual(['Review'])
 await act(async()=>{await dialog.findAllByType('button').find(n=>n.children.includes('Remove from agent'))!.props.onClick()})
 expect(toggle).toHaveBeenLastCalledWith('a',false)
 act(()=>tree.unmount())
})
test('failed installs remain visible with an error and readonly agents cannot install',async()=>{
 let tree!:ReturnType<typeof create>;const toggle=vi.fn().mockRejectedValue(new Error('Permission changed'))
 act(()=>{tree=create(<AgentSkillCatalog skills={[b]} installed={[]} canEdit onToggle={toggle}/>,{createNodeMock:nodes})})
 act(()=>tree.root.findAllByType('button').find(n=>n.children.includes('Add skills'))!.props.onClick())
 await act(async()=>{await tree.root.findByType('dialog').findAllByType('button').find(n=>n.children.includes('Install'))!.props.onClick()})
 expect(tree.root.findByProps({role:'alert'}).children).toContain('Permission changed')
 expect(tree.root.findByType('dialog').findAllByType('strong')).toHaveLength(1)
 act(()=>tree.root.findByType('dialog').props.onCancel({preventDefault(){}}))
 expect(tree.root.findAllByType('dialog')).toHaveLength(0)
 act(()=>tree.update(<AgentSkillCatalog skills={[b]} installed={[]} canEdit={false} onToggle={toggle}/>))
 expect(tree.root.findAllByType('button').find(n=>n.children.includes('Add skills'))!.props.disabled).toBe(true)
 act(()=>tree.unmount())
})
test('file import is reviewed and saved privately through the caller before explicit installation',async()=>{
 let tree!:ReturnType<typeof create>
 const preview=vi.fn().mockResolvedValue({name:'Imported',description:'Check inputs',body:'Instructions',metadata:{license:'MIT'}})
 const save=vi.fn().mockResolvedValue(undefined),toggle=vi.fn()
 act(()=>{tree=create(<AgentSkillCatalog skills={[]} installed={[]} canEdit onToggle={toggle} onPreviewImport={preview} onSaveImport={save}/>,{createNodeMock:nodes})})
 act(()=>tree.root.findAllByType('button').find(n=>n.children.includes('Add skills'))!.props.onClick())
 await act(async()=>{tree.root.findByProps({type:'file'}).props.onChange({target:{files:[{name:'SKILL.md',size:100,text:async()=> 'markdown'}],value:'file'}})})
 expect(preview).toHaveBeenCalledWith('markdown');expect(save).not.toHaveBeenCalled();expect(toggle).not.toHaveBeenCalled()
 expect(JSON.stringify(tree.toJSON())).toContain('Instructions')
 await act(async()=>{tree.root.findAllByType('button').find(n=>n.children.includes('Save'))!.props.onClick()})
 expect(save).toHaveBeenCalledWith({name:'Imported',description:'Check inputs',body:'Instructions',metadata:{license:'MIT'}})
 expect(toggle).not.toHaveBeenCalled()
 expect(tree.root.findAllByProps({'aria-label':'取り込み内容の確認'})).toHaveLength(0)
 act(()=>tree.unmount())
})
