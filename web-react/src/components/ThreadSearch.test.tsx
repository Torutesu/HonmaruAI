import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {ThreadSearch} from './ThreadSearch'
vi.mock('./Dialog',()=>({Dialog:({children}:any)=><section>{children}</section>}))
const api={httpBase:'https://api.example',orgId:'team:test',sessionToken:'token'}
const result=(id:string,cursor:string|null=null)=>({ok:true,json:async()=>({messages:[{id,body:id,createdAt:'2026-10-20T00:00:00Z'}],nextCursor:cursor})})
afterEach(()=>vi.unstubAllGlobals())
test('changing the query cancels and discards the older response',async()=>{
 let resolve!:(value:any)=>void
 const fetch=vi.fn().mockImplementationOnce(()=>new Promise(r=>resolve=r)).mockResolvedValueOnce(result('new'))
 vi.stubGlobal('fetch',fetch)
 let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<ThreadSearch api={api} channel="b:general" threadId="root" onClose={()=>{}} onSelect={()=>{}}/>)})
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'old'}}))
 act(()=>tree.root.findByType('form').props.onSubmit({preventDefault(){}}))
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'new'}}))
 expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
 await act(async()=>tree.root.findByType('form').props.onSubmit({preventDefault(){}}))
 await act(async()=>resolve(result('old')))
 expect(JSON.stringify(tree.toJSON())).toContain('new')
 expect(tree.root.findAllByType('p').some(p=>p.children.includes('old'))).toBe(false)
 act(()=>tree.unmount())
})
test('loads more matches with a cursor and selects the original message',async()=>{
 const fetch=vi.fn().mockResolvedValueOnce(result('first','31')).mockResolvedValueOnce(result('second'))
 vi.stubGlobal('fetch',fetch);const select=vi.fn();let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<ThreadSearch api={api} channel="b:general" threadId="root" onClose={()=>{}} onSelect={select}/>)})
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'needle'}}))
 await act(async()=>tree.root.findByType('form').props.onSubmit({preventDefault(){}}))
 await act(async()=>tree.root.findAllByType('button').find(b=>b.children.includes('さらに表示'))!.props.onClick())
 expect(fetch.mock.calls[1][0]).toContain('before=31')
 expect(fetch.mock.calls[0][0]).toContain('messageId=root')
 act(()=>tree.root.findAllByType('button').find(b=>b.findAllByType('p').some(p=>p.children.includes('second')))!.props.onClick())
 expect(select.mock.calls[0][0].id).toBe('second')
 act(()=>tree.unmount())
})
