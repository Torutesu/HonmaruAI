import {expect,test} from 'vitest'
import {fitFloatingRect,initialFloatingRect} from './floatingApp'
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
