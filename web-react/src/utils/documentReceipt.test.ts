import {test,expect,vi} from 'vitest'
import {readDocumentReceipt,saveDocumentReceipt} from './documentReceipt'
test('receipt contains only valid ID and is isolated by user/workspace/room key',()=>{
 const map=new Map<string,string>();vi.stubGlobal('sessionStorage',{getItem:(k:string)=>map.get(k)||null,setItem:(k:string,v:string)=>map.set(k,v),removeItem:(k:string)=>map.delete(k)})
 const id='12345678-1234-1234-1234-123456789012';saveDocumentReceipt('user-a/org/room',id)
 expect([...map.values()]).toEqual([id]);expect(readDocumentReceipt('user-a/org/room')).toBe(id);expect(readDocumentReceipt('user-b/org/room')).toBeNull()
 saveDocumentReceipt('user-a/org/room',null);expect(readDocumentReceipt('user-a/org/room')).toBeNull();saveDocumentReceipt('user-a/org/room','invalid');expect(map.size).toBe(0)
 vi.unstubAllGlobals()
})
test('disabled storage never prevents document operation',()=>{
 vi.stubGlobal('sessionStorage',{getItem:()=>{throw Error('disabled')},setItem:()=>{throw Error('disabled')}})
 expect(readDocumentReceipt('key')).toBeNull();expect(()=>saveDocumentReceipt('key','12345678-1234-1234-1234-123456789012')).not.toThrow();vi.unstubAllGlobals()
})
