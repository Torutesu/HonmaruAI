import {expect,test} from 'vitest'
import {textMatchRanges} from './textMatches'
test('uses original string offsets with Unicode and literal regex characters',()=>{
 expect(textMatchRanges('İ x x','x')).toEqual([[2,3],[4,5]])
 expect(textMatchRanges('🌸 タスク タスク','タスク')).toEqual([[3,6],[7,10]])
 expect(textMatchRanges('a.* aXX a.*','a.*')).toEqual([[0,3],[8,11]])
 expect(textMatchRanges('Hiring hiring','hiring')).toEqual([[0,6],[7,13]])
 expect(textMatchRanges('text',' ')).toEqual([])
})
