import {expect,test} from 'vitest'
import {describeWorkflowCondition as describe} from './workflowCondition'
test('describes typed values and nested choices without hiding the distinction between null and absence',()=>{
 expect(describe({all:[{path:['input','amount'],op:'gte',value:100},{not:{path:['input','currency'],op:'eq',value:'JPY'}}]})).toBe('(開始時の入力 → amount ≥ 100 かつ 一致しない：開始時の入力 → currency = "JPY")')
 expect(describe({path:['row','value'],op:'in',value:[null,'100',100,false]})).toBe('現在のレコード → value が [空値、"100"、100、いいえ] のいずれか')
 expect(describe({path:['before','name'],op:'exists',value:false})).toBe('変更前のレコード → name が存在しない')
})

test('uses current column names for record paths without changing stored conditions or unrelated input paths',()=>{
 const condition={all:[{path:['row','col_status'],op:'eq' as const,value:'open'},{not:{path:['before','col_status'],op:'exists' as const,value:false}}]}
 const original=JSON.stringify(condition)
 expect(describe(condition,[{id:'col_status',name:'状態',type:'text'}])).toBe('(現在のレコード → 状態 = "open" かつ 一致しない：変更前のレコード → 状態 が存在しない)')
 expect(JSON.stringify(condition)).toBe(original)
 expect(describe({path:['input','col_status'],op:'eq',value:'open'},[{id:'col_status',name:'状態',type:'text'}])).toContain('col_status')
 expect(describe(condition,[])).toContain('col_status')
})
