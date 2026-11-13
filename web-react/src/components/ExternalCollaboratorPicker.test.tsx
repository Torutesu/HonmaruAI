import React from 'react'
import { act, create, type ReactTestRenderer } from 'react-test-renderer'
import { afterEach, expect, test, vi } from 'vitest'
import { ExternalCollaboratorPicker } from './ExternalCollaboratorPicker'

vi.mock('../utils/i18n',()=>({useT:()=>((text:string)=>text)}))
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})

test('waits for a useful query, shows minimal account details and selects a collaborator',async()=>{
 vi.useFakeTimers()
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({people:[{ref:'c1.ari',login:'ari',name:'Ari',email:'private@example.test'},{ref:'c1.ada',login:null,name:'Ada'}]}),{status:200}))
 vi.stubGlobal('fetch',fetch)
 const onChange=vi.fn()
 let tree!:ReactTestRenderer
 await act(async()=>{tree=create(<ExternalCollaboratorPicker httpBase="https://api.example" sessionToken="session" orgId="org-1" resourceType="thread" resourceId="root-1" value={null} onChange={onChange}/>);await Promise.resolve()})
 const input=tree.root.findByType('input')
 act(()=>input.props.onChange({target:{value:'Ar'}}))
 await act(async()=>{await vi.advanceTimersByTimeAsync(300)})
 expect(fetch).not.toHaveBeenCalled()
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'Ari'}}))
 await act(async()=>{await vi.advanceTimersByTimeAsync(250);await Promise.resolve()})
 expect(fetch.mock.calls[0][0]).toContain('resourceType=thread')
 expect(JSON.stringify(tree.toJSON())).toContain('"ari"')
 expect(JSON.stringify(tree.toJSON())).not.toContain('private@example.test')
 // An email or SSO account has no public handle, so none is shown.
 expect(JSON.stringify(tree.toJSON())).toContain('"Ada"')
 expect(JSON.stringify(tree.toJSON())).not.toContain('@null')
 await act(async()=>{tree.root.findAllByType('button')[0].props.onClick();await Promise.resolve()})
 expect(onChange).toHaveBeenCalledWith({ref:'c1.ari',login:'ari',name:'Ari'})
 act(()=>tree.unmount())
})
