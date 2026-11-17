import {expect,test} from 'vitest'
import {roomNameMatches} from './roomNameSearch'

test('matches room-name substrings and tolerates one missing, extra, or mistyped character',()=>{
 expect(roomNameMatches('planning','Planning room')).toBe(true)
 expect(roomNameMatches('plannig','Planning room')).toBe(true)
 expect(roomNameMatches('plannning','Planning room')).toBe(true)
 expect(roomNameMatches('plannxng','Planning room')).toBe(true)
})

test('normalizes compatibility characters and does not fuzzy-match short queries',()=>{
 expect(roomNameMatches('ＡＢＣＤ','room abcd plan')).toBe(true)
 expect(roomNameMatches('gen','General')).toBe(true)
 expect(roomNameMatches('gn','General')).toBe(false)
 expect(roomNameMatches('xxxx','General')).toBe(false)
 expect(roomNameMatches('','General')).toBe(true)
})
