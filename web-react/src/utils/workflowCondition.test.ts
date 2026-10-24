import {expect,test} from 'vitest'
import {describeWorkflowCondition as describe} from './workflowCondition'
test('describes typed values and nested choices without hiding the distinction between null and absence',()=>{
 expect(describe({all:[{path:['input','amount'],op:'gte',value:100},{not:{path:['input','currency'],op:'eq',value:'JPY'}}]})).toBe('(開始時の入力 → amount ≥ 100 かつ 一致しない：開始時の入力 → currency = "JPY")')
 expect(describe({path:['row','value'],op:'in',value:[null,'100',100,false]})).toBe('現在のレコード → value が [空値、"100"、100、いいえ] のいずれか')
 expect(describe({path:['before','name'],op:'exists',value:false})).toBe('変更前のレコード → name が存在しない')
})
