import React from 'react'
import {act,create} from 'react-test-renderer'
import {afterEach,expect,test,vi} from 'vitest'
import {PublicFileShare} from './PublicFileShare'

afterEach(()=>vi.unstubAllGlobals())

test('public file preview is unauthenticated, no-referrer and does not expose internal file ids',async()=>{
 const token=`shr_${'a'.repeat(43)}.${'b'.repeat(43)}`,robots={name:'',content:'',remove:vi.fn()}
 vi.stubGlobal('document',{createElement:()=>robots,head:{appendChild:vi.fn()}})
 const fetcher=vi.fn(async(url:string,options?:RequestInit)=>url.includes('/preview?')?new Response('safe text'):{ok:true,status:200,json:async()=>({share:{name:'plan.txt',version:3,allowDownload:false,expiresAt:null,files:[{name:'plan.txt',version:3,contentType:'text/plain',size:9,fileId:'secret-file-id'}]}})})
 vi.stubGlobal('fetch',fetcher)
 let tree!:ReturnType<typeof create>
 await act(async()=>{tree=create(<PublicFileShare httpBase="https://api.example" token={token}/>)})
 const rendered=JSON.stringify(tree.toJSON())
 expect(rendered).toContain('safe text');expect(rendered).not.toContain('secret-file-id')
 expect(robots.content).toBe('noindex,nofollow,noarchive')
 expect(fetcher.mock.calls.every(([,options])=>options?.credentials==='omit'&&options.referrerPolicy==='no-referrer')).toBe(true)
 act(()=>tree.unmount())
})
