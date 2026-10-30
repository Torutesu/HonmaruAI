import {afterEach,expect,test,vi} from 'vitest'
import {formatElapsedDuration} from './runDuration'

afterEach(()=>vi.useRealTimers())

test('formats a persisted duration and a live duration with the requested locale',()=>{
 expect(formatElapsedDuration('2026-10-24T00:00:00Z','2026-10-24T00:00:44Z','en')).toBe('44 sec')
 expect(formatElapsedDuration('2026-10-24T00:00:00Z','2026-10-24T00:00:44Z','ja')).toBe('44秒')
 expect(formatElapsedDuration('2026-10-24T00:00:00Z',null,'en',Date.parse('2026-10-24T00:00:12Z'))).toBe('12 sec')
})

test('invalid and reversed timestamps never produce a duration',()=>{
 expect(formatElapsedDuration('invalid','2026-10-24T00:00:00Z','en')).toBeNull()
 expect(formatElapsedDuration('2026-10-24T00:00:01Z','2026-10-24T00:00:00Z','en')).toBeNull()
 expect(formatElapsedDuration('2026-10-24T00:00:00Z','invalid','en')).toBeNull()
})
