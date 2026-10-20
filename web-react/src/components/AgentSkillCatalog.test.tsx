import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { AgentSkillCatalog } from './AgentSkillCatalog'
import type { Skill } from '../utils/harness'
vi.mock('../utils/i18n',()=>({useT:()=> (s:string)=>s}))
const a={id:'a',name:'Review',description:'Check releases',body:'Review',createdBy:'alice'} as Skill
const b={id:'b',name:'Report',description:'Weekly summary',body:'Report',createdBy:'bob'} as Skill
const nodes=()=>({showModal:vi.fn(),close:vi.fn(),focus:vi.fn(),querySelector:vi.fn()})
test('an empty catalog does not claim that skills have already been installed',()=>{
 let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<AgentSkillCatalog skills={[]} installed={[]} canEdit onToggle={vi.fn()}/>,{createNodeMock:nodes})})
 act(()=>tree.root.findAllByType('button').find(n=>n.children.includes('Add skills'))!.props.onClick())
 expect(JSON.stringify(tree.toJSON())).toContain('No skills available yet. Import a local skill to get started.')
 expect(JSON.stringify(tree.toJSON())).not.toContain('All available skills are installed.')
 act(()=>tree.update(<AgentSkillCatalog skills={[a]} installed={[a]} canEdit onToggle={vi.fn()}/>))
 expect(JSON.stringify(tree.toJSON())).toContain('All available skills are installed.')
 act(()=>tree.unmount())
})
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
 expect(tree.root.findAllByProps({role:'alert'})).toHaveLength(0)
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
 await act(async()=>{tree.root.findByProps({type:'file',accept:'.md,.zip,text/markdown,application/zip'}).props.onChange({target:{files:[{name:'SKILL.md',size:100,text:async()=> 'markdown'}],value:'file'}})})
 expect(preview).toHaveBeenCalledWith('markdown');expect(save).not.toHaveBeenCalled();expect(toggle).not.toHaveBeenCalled()
 expect(JSON.stringify(tree.toJSON())).toContain('Instructions')
 await act(async()=>{tree.root.findAllByType('button').find(n=>n.children.includes('Save'))!.props.onClick()})
 expect(save).toHaveBeenCalledWith({name:'Imported',description:'Check inputs',body:'Instructions',metadata:{license:'MIT'}})
 expect(toggle).not.toHaveBeenCalled()
 expect(tree.root.findAllByProps({'aria-label':'Review skill import'})).toHaveLength(0)
 act(()=>tree.unmount())
})
test('invalid files do not reach the server and a failed save retains the reviewed draft for retry',async()=>{
 let tree!:ReturnType<typeof create>
 const preview=vi.fn().mockResolvedValue({name:'Imported',description:'Review',body:'Keep this'})
 const save=vi.fn().mockRejectedValueOnce(new Error('Network unavailable')).mockResolvedValue(undefined)
 act(()=>{tree=create(<AgentSkillCatalog skills={[]} installed={[]} canEdit onToggle={vi.fn()} onPreviewImport={preview} onSaveImport={save}/>,{createNodeMock:nodes})})
 act(()=>tree.root.findAllByType('button').find(n=>n.children.includes('Add skills'))!.props.onClick())
 const choose=async(name:string,size:number)=>{await act(async()=>{tree.root.findByProps({type:'file',accept:'.md,.zip,text/markdown,application/zip'}).props.onChange({target:{files:[{name,size,text:async()=> 'markdown'}],value:'file'}})})}
 await choose('archive.exe',100);await choose('SKILL.md',65537)
 expect(preview).not.toHaveBeenCalled()
 await choose('SKILL.md',100)
 const saveButton=()=>tree.root.findAllByType('button').find(n=>n.children.includes('Save'))!
 await act(async()=>{saveButton().props.onClick()})
 expect(tree.root.findByProps({role:'alert'}).children).toContain('Network unavailable')
 expect(tree.root.findAllByProps({'aria-label':'Review skill import'})).toHaveLength(1)
 await act(async()=>{saveButton().props.onClick()})
 expect(save).toHaveBeenCalledTimes(2)
 expect(tree.root.findAllByProps({'aria-label':'Review skill import'})).toHaveLength(0)
 act(()=>tree.unmount())
})

test('creator names display and search without exposing the internal ID as the label',()=>{
 let tree!:ReturnType<typeof create>
 const skill={...b,createdBy:'9401',createdByName:'Mika Tanaka'}
 act(()=>{tree=create(<AgentSkillCatalog skills={[skill]} installed={[skill]} canEdit onToggle={vi.fn()}/>,{createNodeMock:nodes})})
 expect(tree.root.findByProps({className:'hx-skill-author'}).children.join('')).toContain('Mika Tanaka')
 expect(tree.root.findByProps({className:'hx-skill-author'}).children.join('')).not.toContain('9401')
 act(()=>tree.root.findAllByType('button').find(n=>n.children.includes('Add skills'))!.props.onClick())
 const dialog=tree.root.findByType('dialog')
 act(()=>dialog.findAllByProps({role:'tab'})[1].props.onClick())
 act(()=>dialog.findByType('input').props.onChange({target:{value:'MIKA'}}))
 expect(dialog.findAllByType('strong').map(n=>n.children.join(''))).toEqual(['Report'])
 act(()=>tree.unmount())
})

test('folder import reviews file names and saves exact assets without automatic installation',async()=>{
 let tree!:ReturnType<typeof create>
 const draft={name:'Package',description:'Report',body:'Read assets/image.bin',files:[{path:'assets/image.bin',size:3,base64:'AP+A'}]}
 const preview=vi.fn().mockResolvedValue(draft),save=vi.fn().mockResolvedValue(undefined),toggle=vi.fn()
 act(()=>{tree=create(<AgentSkillCatalog skills={[]} installed={[]} canEdit onToggle={toggle} onPreviewImport={preview} onSaveImport={save}/>,{createNodeMock:nodes})})
 act(()=>tree.root.findAllByType('button').find(n=>n.children.includes('Add skills'))!.props.onClick())
 await act(async()=>{tree.root.findByProps({'aria-label':'Skill folder'}).props.onChange({target:{files:[{name:'image.bin',webkitRelativePath:'package/assets/image.bin',size:3,arrayBuffer:async()=>new Uint8Array([0,255,128]).buffer}],value:'folder'}})})
 expect(preview).toHaveBeenCalledWith({files:[{path:'package/assets/image.bin',base64:'AP+A'}]})
 expect(JSON.stringify(tree.root.findByProps({'aria-label':'Support files'}).children.map(n=>typeof n==='string'?n:n.props.children))).toContain('assets/image.bin')
 expect(save).not.toHaveBeenCalled()
 await act(async()=>{tree.root.findAllByType('button').find(n=>n.children.includes('Save'))!.props.onClick()})
 expect(save).toHaveBeenCalledWith(draft);expect(toggle).not.toHaveBeenCalled()
 act(()=>tree.unmount())
})
