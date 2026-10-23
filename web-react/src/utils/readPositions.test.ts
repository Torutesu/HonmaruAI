import {expect,test} from 'vitest'
import {ReadPositions} from './readPositions'
const early='2026-10-23T00:00:00.000Z',late='2026-10-23T01:00:00.000Z'
test('unread wins against delayed read responses, events and snapshots, but a later device read wins',()=>{
 const positions=new ReadPositions()
 expect(positions.accept('room',late,1)).toBe(true)
 expect(positions.accept('room',early,2)).toBe(true)
 expect(positions.accept('room',late,1)).toBe(false)
 expect(positions.snapshot({room:late},{room:1})).toEqual({})
 expect(positions.accept('room',late,3)).toBe(true)
 expect(positions.accept('room',early,2)).toBe(false)
})
test('duplicate acknowledgments cannot overwrite a newer local optimistic read',()=>{
 const positions=new ReadPositions()
 expect(positions.accept('room',early,2)).toBe(true)
 expect(positions.accept('room',early,2)).toBe(false)
 expect(positions.accept('room',late)).toBe(false)
 expect(positions.accept('room',late,3)).toBe(true)
})
test('independent channels and scopes do not share revisions; legacy snapshots remain usable',()=>{
 const positions=new ReadPositions()
 expect(positions.snapshot({a:early,b:late})).toEqual({a:early,b:late})
 expect(positions.accept('a',late,9)).toBe(true)
 expect(positions.accept('b',early,1)).toBe(true)
 expect(new ReadPositions().accept('a',early,1)).toBe(true)
 expect(positions.accept('a','invalid',10)).toBe(false)
})
