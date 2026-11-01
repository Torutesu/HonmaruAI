import {describe,expect,it} from 'vitest'
import {hasRemovedFilter} from './workflowFilters'
import type {Column} from './harness'

const columns:Column[]=[{id:'status',name:'Status',type:'select',options:['A','B']},{id:'priority',name:'Priority',type:'number'}]

describe('removed workflow filters',()=>{
 it('treats a restored alias and a scalar/singleton as the same predicate',()=>{
  expect(hasRemovedFilter({Status:'A'},{status:['A']},columns)).toBe(false)
  expect(hasRemovedFilter({Status:'A'},undefined,columns)).toBe(true)
 })
 it('counts separate AND predicates even if they resolve to the same column',()=>{
  expect(hasRemovedFilter({Status:'A',status:'B'},{status:'B'},columns)).toBe(true)
  expect(hasRemovedFilter({Status:'A',status:'B'},{status:'B',STATUS:'A'},columns)).toBe(false)
 })
 it('uses the first matching column in the same order as the worker',()=>{
  const colliding:Column[]=[{id:'first',name:'status',type:'text'},{id:'status',name:'State',type:'select'}]
  expect(hasRemovedFilter({status:'A'},{first:'A'},colliding)).toBe(false)
  expect(hasRemovedFilter({status:'A'},{State:'A'},colliding)).toBe(true)
 })
 it('compares unavailable keys literally, including prototype names',()=>{
  expect(hasRemovedFilter(JSON.parse('{"__proto__":"A","constructor":"B"}'),JSON.parse('{"constructor":"B"}'),[])).toBe(true)
  expect(hasRemovedFilter({Missing:'A'},{missing:'A'},[])).toBe(true)
 })
})
