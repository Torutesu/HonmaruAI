import React from 'react'
import { act, create } from 'react-test-renderer'
import { expect, test, vi } from 'vitest'
import { AgentMemoryEditor } from './AgentMemoryEditor'
vi.mock('./Dialog', () => ({ Dialog: ({ children, footer }: any) => <section>{children}{footer}</section> }))
vi.mock('../utils/i18n', () => ({ useT: () => (text: string) => text }))
test('memory editor keeps multiline draft after conflict and prevents overlapping saves', async () => {
 const close=vi.fn(),save=vi.fn().mockRejectedValueOnce(new Error('This memory changed. Reload before saving.'))
 let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<AgentMemoryEditor memory={{id:'m',text:'Legacy note',source:'person',createdAt:'2026-10-21'}} onSave={save} onClose={close}/>)})
 act(()=>tree.root.findByProps({maxLength:16000}).props.onChange({target:{value:'# Draft\n\nStill here'}}))
 const submit=()=>tree.root.findAllByType('button').find(button=>button.children.includes('Save'))!
 await act(async()=>{submit().props.onClick();submit().props.onClick()})
 expect(save).toHaveBeenCalledTimes(1)
 expect(save).toHaveBeenCalledWith({title:'Legacy note',description:'',body:'# Draft\n\nStill here',kind:'context'})
 expect(close).not.toHaveBeenCalled()
 expect(tree.root.findByProps({maxLength:16000}).props.value).toContain('Still here')
 expect(tree.root.findByProps({role:'alert'}).children.join('')).toContain('Reload')
 act(()=>tree.unmount())
})
