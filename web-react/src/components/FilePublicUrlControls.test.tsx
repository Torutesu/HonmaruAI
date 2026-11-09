import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {FilePublicUrlControls} from './FilePublicUrlControls'

afterEach(()=>vi.unstubAllGlobals())

const file={id:'f_photo',scope:'workspace',path:'images/photo.png',createdBy:'owner',createdAt:'2026-11-01',updatedAt:'2026-11-02',version:2,deleted:false,contentType:'image/png',size:12}
const current={version:2,kind:'content' as const,contentType:'image/png',size:12,createdBy:'owner',createdAt:'2026-11-02',restoredFrom:null,currentVersion:2,isCurrent:true,purged:false}
const token=`fpu_${'a'.repeat(43)}.${'b'.repeat(43)}`

test('Harness media controls create, display, and revoke a stable direct URL',async()=>{
 vi.stubGlobal('navigator',{clipboard:{writeText:vi.fn()}})
 vi.stubGlobal('window',{confirm:()=>true})
 const api:any={
  filePublicUrl:vi.fn().mockResolvedValue({url:null,version:2,contentType:'image/png',canCreate:true,canRevoke:true}),
  createFilePublicUrl:vi.fn().mockResolvedValue({url:`https://api.example/workspace-file-public-urls/${token}`,version:2,contentType:'image/png',reused:false}),
  revokeFilePublicUrls:vi.fn().mockResolvedValue({revoked:true,count:1}),
 }
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<FilePublicUrlControls api={api} file={file} current={current} enabled/>)})
 expect(JSON.stringify(tree.toJSON())).toContain('Permanent media URL')
 const createButton=tree.root.findAllByType('button').find(button=>button.children.includes('Create permanent URL'))!
 await act(async()=>createButton.props.onClick())
 expect(api.createFilePublicUrl).toHaveBeenCalledWith('f_photo')
 expect(JSON.stringify(tree.toJSON())).toContain(token)
 const revokeButton=tree.root.findAllByType('button').find(button=>button.children.includes('Revoke all URLs for this file'))!
 await act(async()=>revokeButton.props.onClick())
 expect(api.revokeFilePublicUrls).toHaveBeenCalledWith('f_photo')
 expect(JSON.stringify(tree.toJSON())).not.toContain(token)
 act(()=>tree.unmount())
})

test('media URL controls stay hidden for non-media files and outside Harness mode',async()=>{
 const api:any={filePublicUrl:vi.fn()}
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<FilePublicUrlControls api={api} file={{...file,contentType:'text/plain'}} current={{...current,contentType:'text/plain'}} enabled/>)})
 expect(tree.toJSON()).toBeNull();expect(api.filePublicUrl).not.toHaveBeenCalled();act(()=>tree.unmount())
 await act(async()=>{tree=create(<FilePublicUrlControls api={api} file={file} current={current} enabled={false}/>)})
 expect(tree.toJSON()).toBeNull();expect(api.filePublicUrl).not.toHaveBeenCalled();act(()=>tree.unmount())
})

test('media URL controls accept uncommon types from the supported MIME categories',async()=>{
 const api:any={filePublicUrl:vi.fn().mockResolvedValue({url:null,version:2,contentType:'image/vnd.adobe.photoshop',canCreate:true,canRevoke:false}),createFilePublicUrl:vi.fn(),revokeFilePublicUrls:vi.fn()}
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<FilePublicUrlControls api={api} file={{...file,contentType:'image/vnd.adobe.photoshop'}} current={{...current,contentType:'image/vnd.adobe.photoshop'}} enabled/>)})
 expect(api.filePublicUrl).toHaveBeenCalledWith('f_photo',expect.any(AbortSignal))
 expect(JSON.stringify(tree.toJSON())).toContain('Permanent media URL')
 act(()=>tree.unmount())
})
