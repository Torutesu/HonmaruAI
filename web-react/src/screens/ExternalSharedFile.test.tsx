import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {ExternalSharedFile} from './ExternalSharedFile'
vi.mock('../utils/i18n',()=>({useT:()=>((text:string)=>text)}))
afterEach(()=>vi.unstubAllGlobals())
test('signed-in recipient redeems a file link and sees only read-only version actions',async()=>{
 vi.stubGlobal('localStorage',{getItem:()=> 'session-token'})
 const fetcher=vi.fn()
  .mockResolvedValueOnce(new Response(JSON.stringify({file:{id:'file-1',path:'plan.txt',scope:'b:secret-room',createdBy:'internal-user-73',version:2,contentType:'text/plain',size:12}})))
  .mockResolvedValueOnce(new Response(JSON.stringify({versions:[{version:2,kind:'content',createdAt:'2026-11-06T00:00:00Z',isCurrent:true,purged:false}]})))
 vi.stubGlobal('fetch',fetcher)
 let tree:ReturnType<typeof create>
 await act(async()=>{tree=create(<ExternalSharedFile httpBase="https://api.test" orgId="org id" fileId="file/1"/>)})
 expect(JSON.stringify(tree!.toJSON())).toContain('plan.txt')
 expect(JSON.stringify(tree!.toJSON())).not.toContain('secret-room')
 expect(JSON.stringify(tree!.toJSON())).not.toContain('internal-user-73')
 expect(JSON.stringify(tree!.toJSON())).not.toContain('reports/')
 expect(JSON.stringify(tree!.toJSON())).toContain('Read-only access')
 expect(fetcher.mock.calls[0][0]).toBe('https://api.test/external/files/org%20id/file%2F1')
 expect(fetcher.mock.calls[0][1].headers['x-session-token']).toBe('session-token')
 expect(tree!.root.findAllByType('button').map(button=>button.children.join(''))).toContain('Download')
 expect(tree!.root.findAllByType('button').map(button=>button.children.join(''))).not.toContain('Edit')
 act(()=>tree!.unmount())
})