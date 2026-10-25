import {EventEmitter} from 'node:events'
import {afterEach,expect,test,vi} from 'vitest'
import {installDelayedRepaint} from '../src/repaint.js'
afterEach(()=>vi.useRealTimers())
function setup(){vi.useFakeTimers();const contents=new EventEmitter();contents.isDestroyed=vi.fn(()=>false);contents.invalidate=vi.fn();const visible=vi.fn(()=>true);const dispose=installDelayedRepaint(contents,{visible});return{contents,visible,dispose}}
test('asynchronous document rendering gets bounded repaint opportunities without reload',()=>{
 const {contents,dispose}=setup();contents.emit('did-finish-load');expect(contents.invalidate).toHaveBeenCalledTimes(1)
 vi.advanceTimersByTime(10000);expect(contents.invalidate).toHaveBeenCalledTimes(4)
 vi.advanceTimersByTime(60000);expect(contents.invalidate).toHaveBeenCalledTimes(4);dispose()
})
test('navigation cancels the previous document work; destruction clears timers and listeners',()=>{
 const {contents}=setup();contents.emit('did-finish-load');contents.emit('did-start-navigation',{isMainFrame:true,isSameDocument:false});vi.advanceTimersByTime(10000);expect(contents.invalidate).toHaveBeenCalledTimes(1)
 contents.emit('did-finish-load');contents.emit('destroyed');vi.advanceTimersByTime(10000);expect(contents.invalidate).toHaveBeenCalledTimes(2);expect(contents.listenerCount('did-finish-load')).toBe(0)
})
test('hidden and destroyed windows are never repainted',()=>{
 const {contents,visible,dispose}=setup();visible.mockReturnValue(false);contents.emit('did-finish-load');vi.advanceTimersByTime(3000);expect(contents.invalidate).not.toHaveBeenCalled()
 visible.mockReturnValue(true);contents.isDestroyed.mockReturnValue(true);vi.advanceTimersByTime(10000);expect(contents.invalidate).not.toHaveBeenCalled();dispose()
})
