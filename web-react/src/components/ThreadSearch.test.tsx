import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {ThreadSearch} from './ThreadSearch'
const api={httpBase:'https://api.example',orgId:'team:test',sessionToken:'token'}
const result=(id:string,cursor:string|null=null)=>({ok:true,json:async()=>({messages:[{id,body:id,createdAt:'2026-10-20T00:00:00Z'}],nextCursor:cursor})})
afterEach(()=>{vi.unstubAllGlobals();vi.useRealTimers()})
test('query changes abort old searches and discard delayed results',async()=>{
 vi.useFakeTimers();let resolve!:(value:any)=>void
 const fetch=vi.fn().mockImplementationOnce(()=>new Promise(r=>resolve=r)).mockResolvedValueOnce(result('new'));vi.stubGlobal('fetch',fetch)
 const select=vi.fn();let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<ThreadSearch api={api} channel="b:general" threadId="root" onClose={()=>{}} onSelect={select}/>)})
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'old'}}));await act(async()=>{await vi.advanceTimersByTimeAsync(250)})
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'new'}}));expect(fetch.mock.calls[0][1].signal.aborted).toBe(true)
 await act(async()=>{await vi.advanceTimersByTimeAsync(250)});await act(async()=>resolve(result('old')))
 expect(select.mock.calls.map(call=>call[0].id)).toEqual(['new']);act(()=>tree.unmount())
})
test('collects every page and navigates older and newer matches without closing',async()=>{
 vi.useFakeTimers();const fetch=vi.fn().mockResolvedValueOnce(result('newest','31')).mockResolvedValueOnce(result('older'));vi.stubGlobal('fetch',fetch)
 const select=vi.fn(),close=vi.fn();let tree!:ReturnType<typeof create>
 act(()=>{tree=create(<ThreadSearch api={api} channel="b:general" threadId="root" onClose={close} onSelect={select}/>)})
 act(()=>tree.root.findByType('input').props.onChange({target:{value:'needle'}}));await act(async()=>{await vi.advanceTimersByTimeAsync(250)})
 expect(fetch.mock.calls[1][0]).toContain('before=31');expect(select.mock.calls[0][0].id).toBe('newest')
 act(()=>tree.root.findByProps({'aria-label':'前の結果へ'}).props.onClick());expect(select.mock.calls.at(-1)![0].id).toBe('older')
 act(()=>tree.root.findByProps({'aria-label':'新しい結果へ'}).props.onClick());expect(select.mock.calls.at(-1)![0].id).toBe('newest')
 expect(close).not.toHaveBeenCalled();act(()=>tree.unmount())
})
