import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {ExternalSharedFile} from './ExternalSharedFile'
const translations=vi.hoisted(()=>({identity:(text:string)=>text}))
vi.mock('../utils/i18n',()=>({useT:()=>translations.identity}))
afterEach(()=>vi.unstubAllGlobals())
test('signed-in view recipient sees downloads without upload controls',async()=>{
 vi.stubGlobal('localStorage',{getItem:()=> 'session-token'})
 const fetcher=vi.fn()
  .mockResolvedValueOnce(new Response(JSON.stringify({permission:'view',file:{id:'file-1',path:'plan.txt',scope:'b:secret-room',createdBy:'internal-user-73',version:2,contentType:'text/plain',size:12}})))
  .mockResolvedValueOnce(new Response(JSON.stringify({versions:[{version:2,kind:'content',createdAt:'2026-11-06T00:00:00Z',isCurrent:true,purged:false}]})))
 vi.stubGlobal('fetch',fetcher)
 let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalSharedFile httpBase="https://api.test" orgId="org id" fileId="file/1"/>)})
 expect(JSON.stringify(tree!.toJSON())).toContain('plan.txt')
 expect(JSON.stringify(tree!.toJSON())).not.toContain('secret-room')
 expect(JSON.stringify(tree!.toJSON())).not.toContain('internal-user-73')
 expect(JSON.stringify(tree!.toJSON())).not.toContain('reports/')
 expect(JSON.stringify(tree!.toJSON())).toContain('Can view')
 expect(fetcher.mock.calls[0][0]).toBe('https://api.test/external/files/org%20id/file%2F1')
 expect(fetcher.mock.calls[0][1].headers['x-session-token']).toBe('session-token')
 expect(tree!.root.findAllByType('button').map(button=>button.children.join(''))).toContain('Download')
 expect(tree!.root.findAllByType('button').map(button=>button.children.join(''))).not.toContain('Upload new version')
 act(()=>tree!.unmount())
})

test('edit recipient uploads an exact-file version and reloads metadata and history',async()=>{
 vi.stubGlobal('localStorage',{getItem:()=> 'session-token'})
 const history={versions:[{version:2,kind:'content',createdAt:'2026-11-06T00:00:00Z',isCurrent:true,purged:false}]}
 const fetcher=vi.fn()
  .mockResolvedValueOnce(new Response(JSON.stringify({permission:'edit',file:{id:'file-1',path:'plan.txt',version:1,contentType:'text/plain',size:4}})))
  .mockResolvedValueOnce(new Response(JSON.stringify({permission:'edit',...{versions:[{version:1,kind:'content',createdAt:'2026-11-05T00:00:00Z',isCurrent:true,purged:false}]}})))
  .mockResolvedValueOnce(new Response(JSON.stringify({saved:true,version:2})))
  .mockResolvedValueOnce(new Response(JSON.stringify({permission:'edit',file:{id:'file-1',path:'plan.txt',version:2,contentType:'text/plain',size:7}})))
  .mockResolvedValueOnce(new Response(JSON.stringify(history)))
 vi.stubGlobal('fetch',fetcher)
 let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalSharedFile httpBase="https://api.test" orgId="org" fileId="file-1"/>)})
 const input=tree!.root.findByProps({type:'file'})
 const content={name:'next.txt',size:7,type:'text/plain'} as File
 await act(async()=>input.props.onChange({target:{files:[content],value:'next.txt'}}))
 expect(fetcher.mock.calls[2][0]).toBe('https://api.test/external/files/org/file-1/content?expectedVersion=1&size=7')
 expect(fetcher.mock.calls[2][1]).toMatchObject({method:'PUT',headers:{'x-session-token':'session-token','content-type':'text/plain'},body:content})
 expect(JSON.stringify(tree!.toJSON())).toContain('Can edit')
 expect(JSON.stringify(tree!.toJSON())).toContain('Current version')
 expect(JSON.stringify(tree!.toJSON())).toContain('"2"')
 act(()=>tree!.unmount())
})
