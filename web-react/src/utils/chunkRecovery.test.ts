import { expect, test, vi } from 'vitest'
import { isMissingAppChunk, recoverMissingAppChunk } from './chunkRecovery'
const origin = 'https://app.honmaruai.com'
const missing = new TypeError(`Failed to fetch dynamically imported module: ${origin}/assets/HarnessAgents-B7Q87iit.js`)
test('only failed same-origin hashed modules trigger recovery', () => {
 expect(isMissingAppChunk(missing, origin)).toBe(true)
 for (const error of [new Error('Rendering failed'), new Error(`see ${origin}/assets/A-abc.js`), new TypeError('Failed to fetch dynamically imported module: https://other.test/assets/A-abc.js'), new TypeError(`Failed to fetch dynamically imported module: ${origin}/api/private.js`)]) expect(isMissingAppChunk(error,origin)).toBe(false)
})
test('reload is bounded across remounts and skipped offline or without persistent guard', () => {
 const data = new Map<string,string>()
 const storage = {getItem:(key:string)=>data.get(key)??null,setItem:(key:string,value:string)=>{data.set(key,value)}}
 const reload = vi.fn(), options = {origin,storage,reload,online:true,now:1000000}
 expect(recoverMissingAppChunk(missing,{...options,online:false})).toBe(false)
 expect(recoverMissingAppChunk(missing,options)).toBe(true)
 expect(recoverMissingAppChunk(missing,{...options,now:1000001})).toBe(false)
 expect(reload).toHaveBeenCalledTimes(1)
 expect(recoverMissingAppChunk(missing,{...options,now:1300001})).toBe(true)
 expect(recoverMissingAppChunk(missing,{...options,storage:{getItem:()=>null,setItem:()=>{throw new Error('blocked')}}})).toBe(false)
 expect(reload).toHaveBeenCalledTimes(2)
})
