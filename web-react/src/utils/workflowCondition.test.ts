import {expect,test} from 'vitest'
import {describeWorkflowCondition as describe} from './workflowCondition'
test('describes typed values and nested choices without hiding the distinction between null and absence',()=>{
 expect(describe({all:[{path:['input','amount'],op:'gte',value:100},{not:{path:['input','currency'],op:'eq',value:'JPY'}}]})).toBe('(Starting input → amount ≥ 100 and Not: Starting input → currency = "JPY")')
 expect(describe({path:['row','value'],op:'in',value:[null,'100',100,false]})).toBe('Current record → value is one of [Null value, "100", 100, No]')
 expect(describe({path:['before','name'],op:'exists',value:false})).toBe('Previous record → name does not exist')
})

test('uses current column names for record paths without changing stored conditions or unrelated input paths',()=>{
 const condition={all:[{path:['row','col_status'],op:'eq' as const,value:'open'},{not:{path:['before','col_status'],op:'exists' as const,value:false}}]}
 const original=JSON.stringify(condition)
 expect(describe(condition,[{id:'col_status',name:'状態',type:'text'}])).toBe('(Current record → 状態 = "open" and Not: Previous record → 状態 does not exist)')
 expect(JSON.stringify(condition)).toBe(original)
 expect(describe({path:['input','col_status'],op:'eq',value:'open'},[{id:'col_status',name:'状態',type:'text'}])).toContain('col_status')
 expect(describe(condition,[])).toContain('col_status')
})
