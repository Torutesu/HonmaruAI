import { afterEach, expect, test, vi } from 'vitest'
import { searchExternalCollaborators } from './externalCollaborators'

afterEach(()=>vi.unstubAllGlobals())

test('searches a resource-scoped collaborator directory and returns no email field',async()=>{
 const fetch=vi.fn().mockResolvedValue(new Response(JSON.stringify({people:[{githubId:'guest-1',login:'ari',name:'Ari'}]}),{status:200}))
 vi.stubGlobal('fetch',fetch)
 const result=await searchExternalCollaborators('https://api.example/','session',{orgId:'org-1',resourceType:'file',resourceId:'file-1',query:'Ari'})
 expect(fetch.mock.calls[0][0]).toBe('https://api.example/external/collaborators/search?orgId=org-1&resourceType=file&resourceId=file-1&q=Ari')
 expect(fetch.mock.calls[0][1].headers).toEqual({'x-session-token':'session'})
 expect(result).toEqual([{githubId:'guest-1',login:'ari',name:'Ari'}])
 expect('email' in result[0]).toBe(false)
})

test('surfaces search authorization failures without accepting a response body as a result',async()=>{
 vi.stubGlobal('fetch',vi.fn().mockResolvedValue(new Response(JSON.stringify({message:'Forbidden'}),{status:403})))
 await expect(searchExternalCollaborators('https://api.example','session',{orgId:'org-1',resourceType:'app',resourceId:'app-1',query:'guest'})).rejects.toThrow('Forbidden')
})
