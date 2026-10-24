import {afterEach,expect,test,vi} from 'vitest'
import {generationRetry,finishGenerationRetry} from './generationRetry'
const scope={host:'https://example.test',orgId:'team:one',userId:'1',kind:'workflow',channel:'b:ops',prompt:'Private invoice request'}
afterEach(()=>vi.unstubAllGlobals())
test('an unresolved identity survives module reload without storing the prompt',async()=>{
 const stored=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>stored.get(k)||null,setItem:(k:string,v:string)=>stored.set(k,v),removeItem:(k:string)=>stored.delete(k)})
 const first=await generationRetry(scope)
 vi.resetModules();const reloaded=await import('./generationRetry')
 expect(await reloaded.generationRetry(scope)).toEqual(first)
 expect(JSON.stringify([...stored])).not.toContain(scope.prompt)
 reloaded.finishGenerationRetry(first)
 expect((await reloaded.generationRetry(scope)).id).not.toBe(first.id)
})
test('identities separate users, workspaces, resource kinds and changed prompts',async()=>{
 const first=await generationRetry(scope)
 for(const patch of [{userId:'2'},{orgId:'team:two'},{kind:'app'},{prompt:'Different request'},{timezone:'Asia/Tokyo'}])expect((await generationRetry({...scope,...patch})).id).not.toBe(first.id)
})
test('storage failure keeps a stable in-memory retry and success clears it',async()=>{
 vi.stubGlobal('localStorage',{getItem:()=>{throw Error('blocked')},setItem:()=>{throw Error('blocked')},removeItem:()=>{throw Error('blocked')}})
 const first=await generationRetry({...scope,prompt:'Storage unavailable'})
 expect(await generationRetry({...scope,prompt:'Storage unavailable'})).toEqual(first)
 finishGenerationRetry(first)
 expect((await generationRetry({...scope,prompt:'Storage unavailable'})).id).not.toBe(first.id)
})
test('finishing an older request does not remove a newer stored identity',async()=>{
 const stored=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>stored.get(k)||null,setItem:(k:string,v:string)=>stored.set(k,v),removeItem:(k:string)=>stored.delete(k)})
 const first=await generationRetry({...scope,prompt:'Old completion'})
 stored.set(first.key,'newer-request-identity')
 finishGenerationRetry(first)
 expect(stored.get(first.key)).toBe('newer-request-identity')
})

test('another tab clearing a completed request supersedes stale memory',async()=>{
 const stored=new Map<string,string>();vi.stubGlobal('localStorage',{getItem:(k:string)=>stored.get(k)||null,setItem:(k:string,v:string)=>stored.set(k,v),removeItem:(k:string)=>stored.delete(k)})
 const first=await generationRetry({...scope,prompt:'Other tab completed'})
 stored.delete(first.key)
 expect((await generationRetry({...scope,prompt:'Other tab completed'})).id).not.toBe(first.id)
})

test('quota errors while reads work still retain the current tab retry',async()=>{
 vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{throw Error('quota')},removeItem:()=>{}})
 const first=await generationRetry({...scope,prompt:'Storage full'})
 expect(await generationRetry({...scope,prompt:'Storage full'})).toEqual(first)
})
