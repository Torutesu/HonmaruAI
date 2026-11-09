import {expect,test} from 'vitest'
import {fitFloatingRect,floatingRectStorageKey,initialFloatingRect,readFloatingRect,writeFloatingRect} from './floatingApp'
test('starts at the reference size in the lower right and fits phone displays',()=>{
 expect(initialFloatingRect(1920,1080)).toEqual({x:1428,y:428,width:480,height:640})
 expect(initialFloatingRect(390,844)).toEqual({x:12,y:192,width:366,height:640})
})
test('display changes and oversized drags keep all controls reachable',()=>{
 const viewport={width:800,height:500}
 const fitted=fitFloatingRect({x:1800,y:900,width:1000,height:900},viewport)
 expect(fitted).toEqual({x:12,y:12,width:776,height:476})
 expect(fitFloatingRect({x:-900,y:-100,width:4,height:2},viewport)).toEqual({x:12,y:12,width:360,height:300})
 expect(fitFloatingRect(fitted,viewport)).toEqual(fitted)
})
test('stores geometry per signed-in user, workspace and app, and clamps old geometry to the current viewport',()=>{
 const values=new Map<string,string>()
 const storage={getItem:(key:string)=>values.get(key)||null,setItem:(key:string,value:string)=>{values.set(key,value)}}
 const key=floatingRectStorageKey('user/a','team:one','test_app')!
 writeFloatingRect(storage,key,{x:700,y:400,width:480,height:640})
 expect(readFloatingRect(storage,key,{width:800,height:500})).toEqual({x:308,y:12,width:480,height:476})
 expect(floatingRectStorageKey('user/a','team:one','test_app')).not.toBe(floatingRectStorageKey('user/b','team:one','test_app'))
 expect(floatingRectStorageKey('user/a','team:one','test_app')).not.toBe(floatingRectStorageKey('user/a','team:two','test_app'))
 expect(floatingRectStorageKey('user/a','team:one','test_app')).not.toBe(floatingRectStorageKey('user/a','team:one','other_app'))
})
test('ignores malformed or unavailable storage without breaking the floating workspace',()=>{
 const key='placement'
 expect(readFloatingRect({getItem:()=>'{bad json}',setItem:()=>{}},key,{width:800,height:600})).toBeNull()
 expect(readFloatingRect(undefined,key,{width:800,height:600})).toBeNull()
 writeFloatingRect({getItem:()=>null,setItem:()=>{throw new Error('storage disabled')}},key,{x:12,y:12,width:480,height:640})
})
