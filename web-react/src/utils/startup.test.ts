import {afterEach,expect,test,vi} from 'vitest'
import {startAfterLocale} from './startup'
afterEach(()=>vi.useRealTimers())
test('a blocked translation cannot keep the app blank, and late arrival does not remount it',async()=>{
 vi.useFakeTimers();let finish!:(value:unknown)=>void;const locale=new Promise(resolve=>finish=resolve),start=vi.fn()
 startAfterLocale(locale,start)
 await vi.advanceTimersByTimeAsync(1999);expect(start).not.toHaveBeenCalled()
 await vi.advanceTimersByTimeAsync(1);expect(start).toHaveBeenCalledTimes(1)
 finish(undefined);await Promise.resolve();expect(start).toHaveBeenCalledTimes(1)
})
test('fast translation starts immediately and cancels the fallback timer',async()=>{
 vi.useFakeTimers();const start=vi.fn();startAfterLocale(Promise.resolve(),start)
 await Promise.resolve();expect(start).toHaveBeenCalledTimes(1);expect(vi.getTimerCount()).toBe(0)
 await vi.advanceTimersByTimeAsync(3000);expect(start).toHaveBeenCalledTimes(1)
})
test('failed translation still starts without an unhandled rejection',async()=>{
 vi.useFakeTimers();const start=vi.fn();startAfterLocale(Promise.reject(new Error('Language unavailable')),start)
 await Promise.resolve();expect(start).toHaveBeenCalledTimes(1)
 await vi.runAllTimersAsync();expect(start).toHaveBeenCalledTimes(1)
})
