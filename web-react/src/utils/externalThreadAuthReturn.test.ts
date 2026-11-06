import {expect,test} from 'vitest'
import {externalThreadAuthReturnPath,rememberExternalThreadAuthReturn,takeExternalThreadAuthReturn} from './externalThreadAuthReturn'

function storage(){
 const values=new Map<string,string>()
 return {
  getItem:(key:string)=>values.get(key)||null,
  setItem:(key:string,value:string)=>{values.set(key,value)},
  removeItem:(key:string)=>{values.delete(key)},
 }
}

test('preserves only the canonical exact Thread route across SSO and consumes it once',()=>{
 const session=storage()
 expect(rememberExternalThreadAuthReturn(session,'#/external-thread/team%3Aone/root%20one')).toBe(true)
 expect(rememberExternalThreadAuthReturn(session,'#/sso/done?code=once')).toBe(false)
 expect(takeExternalThreadAuthReturn(session)).toBe('#/external-thread/team%3Aone/root%20one')
 expect(takeExternalThreadAuthReturn(session)).toBeNull()
})

test('clears stale destinations on normal navigation and rejects malformed routes',()=>{
 const session=storage()
 rememberExternalThreadAuthReturn(session,'#/external-thread/team/root')
 rememberExternalThreadAuthReturn(session,'#/feed')
 expect(takeExternalThreadAuthReturn(session)).toBeNull()
 expect(externalThreadAuthReturnPath('#/external-thread/%E0%A4%A/root')).toBeNull()
 expect(externalThreadAuthReturnPath('#/external-thread/team/../root')).toBeNull()
 expect(externalThreadAuthReturnPath('#/external-thread//root')).toBeNull()
})
