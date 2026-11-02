import {describe,expect,it} from 'vitest'
import {decimalMatchesNumber,numberPreservesDecimal} from './numericPrecision'

describe('decimal input before conversion to Number',()=>{
 it.each(['0','-0','0.1','.50','1.00','1e3','1e-7','9007199254740992','1e20','-1e20'])('accepts round-trippable value %s',value=>expect(numberPreservesDecimal(value)).toBe(true))
 it.each(['9007199254740993','1000000000000000100','1e23','1e-324','1.0000000000000001','1e999999999999999999','invalid','0'.repeat(20001)])('rejects changed or unbounded value %#',value=>expect(numberPreservesDecimal(value)).toBe(false))
 it('compares returned values without silently accepting rounded integers',()=>{
  expect(decimalMatchesNumber('1000000000000000100',Number('1000000000000000100'))).toBe(false)
  expect(decimalMatchesNumber('1e20',1e20)).toBe(true)
  expect(decimalMatchesNumber('1',Infinity)).toBe(false)
 })
})
