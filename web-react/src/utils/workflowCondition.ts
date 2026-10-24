import type {ConditionScalar,WorkflowCondition} from './harness'
const scalar=(value:ConditionScalar):string=>value===null?'空値':typeof value==='boolean'?(value?'はい':'いいえ'):typeof value==='string'?JSON.stringify(value):String(value)
export function describeWorkflowCondition(condition:WorkflowCondition):string {
 if('all'in condition)return `(${condition.all.map(describeWorkflowCondition).join(' かつ ')})`
 if('any'in condition)return `(${condition.any.map(describeWorkflowCondition).join(' または ')})`
 if('not'in condition)return `一致しない：${describeWorkflowCondition(condition.not)}`
 const sources:Record<string,string>={input:'開始時の入力',row:'現在のレコード',before:'変更前のレコード',steps:'前のステップ'}
 const path=[sources[condition.path[0]]||condition.path[0],...condition.path.slice(1)].join(' → ')
 if(condition.op==='exists')return `${path} が${condition.value?'存在する':'存在しない'}`
 if(condition.op==='in')return `${path} が [${(condition.value as ConditionScalar[]).map(scalar).join('、')}] のいずれか`
 const operators={eq:'=',neq:'≠',gt:'>',gte:'≥',lt:'<',lte:'≤',contains:'に含む文字'}
 return `${path} ${operators[condition.op]} ${scalar(condition.value as ConditionScalar)}`
}
