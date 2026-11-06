import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {FileShareControls} from './FileShareControls'

afterEach(()=>vi.unstubAllGlobals())

const file={id:'f_one',scope:'workspace',path:'docs/plan.txt',createdBy:'owner',createdAt:'2026-11-01',updatedAt:'2026-11-02',version:2,deleted:false,contentType:'text/plain',size:15}
const current={version:2,kind:'content' as const,contentType:'text/plain',size:15,createdBy:'owner',createdAt:'2026-11-02',restoredFrom:null,currentVersion:2,isCurrent:true,purged:false}

test('Harness offers a public snapshot and Simple keeps sharing controls absent',async()=>{
 vi.stubGlobal('location',{origin:'https://app.example',pathname:'/',search:''})
 vi.stubGlobal('crypto',{randomUUID:()=> 'request-id'})
 const api:any={fileShares:vi.fn().mockResolvedValue({shares:[],canManage:true}),createFileShare:vi.fn().mockResolvedValue({share:{},token:`shr_${'a'.repeat(43)}.${'b'.repeat(43)}`})}
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<FileShareControls api={api} file={file} current={current} enabled/>)})
 expect(JSON.stringify(tree.toJSON())).toContain('Public sharing')
 const createButton=tree.root.findAllByType('button').find(button=>button.children.includes('Create public link'))!
 await act(async()=>createButton.props.onClick())
 expect(api.createFileShare).toHaveBeenCalledWith('f_one',expect.objectContaining({version:2,expiresIn:'never',allowDownload:true,reusable:true,requestKey:'share_requestid'}))
 expect(JSON.stringify(tree.toJSON())).toContain('#/file-share/shr_')
 act(()=>tree.unmount())
 await act(async()=>{tree=create(<FileShareControls api={api} file={file} current={current} enabled={false}/>)})
 expect(tree.toJSON()).toBeNull();act(()=>tree.unmount())
})
