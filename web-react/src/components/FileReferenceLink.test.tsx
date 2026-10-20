import React from 'react'
import {act,create} from 'react-test-renderer'
import {expect,test,vi} from 'vitest'
import {FileReferenceLink} from './Attachments'

vi.mock('./DocumentPreview',()=>({default:({href,onClose}:any)=><section data-preview={href}><button onClick={onClose}>Close</button></section>}))

test('reference documents open the reader, while modified clicks and unsupported files remain links',async()=>{
 const file={id:'f',name:'Notes.pdf',type:'application/pdf',size:20,url:'/files/f'}
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<FileReferenceLink file={file} href="https://api.example/files/f">Notes</FileReferenceLink>)})
 const preventDefault=vi.fn()
 await act(async()=>tree.root.findByType('a').props.onClick({button:0,metaKey:true,preventDefault}))
 expect(preventDefault).not.toHaveBeenCalled()
 expect(tree.root.findAllByType('section')).toHaveLength(0)
 await act(async()=>tree.root.findByType('a').props.onClick({button:0,preventDefault}))
 expect(preventDefault).toHaveBeenCalledOnce()
 expect(tree.root.findByType('section').props['data-preview']).toBe('https://api.example/files/f')
 await act(async()=>tree.root.findByType('button').props.onClick())
 expect(tree.root.findAllByType('section')).toHaveLength(0)
 await act(async()=>tree.update(<FileReferenceLink file={{...file,name:'archive.zip',type:'application/zip'}} href="/files/f">Archive</FileReferenceLink>))
 preventDefault.mockClear()
 await act(async()=>tree.root.findByType('a').props.onClick({button:0,preventDefault}))
 expect(preventDefault).not.toHaveBeenCalled()
 expect(tree.root.findAllByType('section')).toHaveLength(0)
 act(()=>tree.unmount())
})
