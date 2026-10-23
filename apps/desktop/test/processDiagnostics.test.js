import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { installProcessDiagnostics } from '../src/processDiagnostics.js'
it('classifies GPU and renderer failures without recording native payloads', () => {
 const app = new EventEmitter(), contents = new EventEmitter(), record = vi.fn()
 installProcessDiagnostics(app, contents, record)
 app.emit('child-process-gone', {}, {type:'Utility', reason:'crashed', name:'private'})
 app.emit('child-process-gone', {}, {type:'GPU', reason:'crashed', name:'private', exitCode:999})
 contents.emit('render-process-gone', {}, {reason:'oom', private:'secret'})
 contents.emit('render-process-gone', {}, {reason:'future-private-value'})
 expect(record.mock.calls).toEqual([['gpu-gone',4],['renderer-gone',5],['renderer-gone',0]])
})
it('removes the app-wide listener when a window is destroyed', () => {
 const app = new EventEmitter(), first = new EventEmitter(), second = new EventEmitter(), one = vi.fn(), two = vi.fn()
 installProcessDiagnostics(app, first, one)
 first.emit('destroyed')
 installProcessDiagnostics(app, second, two)
 app.emit('child-process-gone', {}, {type:'GPU', reason:'launch-failed'})
 first.emit('render-process-gone', {}, {reason:'crashed'})
 expect(one).not.toHaveBeenCalled();expect(two).toHaveBeenCalledWith('gpu-gone',6)
 expect(app.listenerCount('child-process-gone')).toBe(1)
 second.emit('destroyed');expect(app.listenerCount('child-process-gone')).toBe(0)
})
it('diagnostic write failures do not interrupt native events', () => {
 const app = new EventEmitter(), contents = new EventEmitter()
 installProcessDiagnostics(app, contents, () => {throw Error('disk unavailable')})
 expect(() => app.emit('child-process-gone', {}, {type:'GPU', reason:'killed'})).not.toThrow()
 expect(() => contents.emit('render-process-gone', {}, {reason:'crashed'})).not.toThrow()
})
