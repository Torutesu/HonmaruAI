import type {ConditionScalar,WorkflowCondition,Table} from './harness'
import {t} from './i18n'
const scalar=(value:ConditionScalar):string=>value===null?t('Null value'):typeof value==='boolean'?t(value?'Yes':'No'):typeof value==='string'?JSON.stringify(value):String(value)
export function describeWorkflowCondition(condition:WorkflowCondition,columns:Table["columns"]=[]):string {
 if('all'in condition)return `(${condition.all.map(child=>describeWorkflowCondition(child,columns)).join(` ${t('and')} `)})`
 if('any'in condition)return `(${condition.any.map(child=>describeWorkflowCondition(child,columns)).join(` ${t('or')} `)})`
 if('not'in condition)return t('Not: {condition}',{condition:describeWorkflowCondition(condition.not,columns)})
 const sources:Record<string,string>={input:'Starting input',row:'Current record',before:'Previous record',steps:'Previous steps'}
 const segments=condition.path.slice(1)
 if(['row','before'].includes(condition.path[0])&&segments.length)segments[0]=columns.find(column=>column.id===segments[0])?.name||segments[0]
 const path=[t(sources[condition.path[0]]||condition.path[0]),...segments].join(' → ')
 if(condition.op==='exists')return t(condition.value?'{path} exists':'{path} does not exist',{path})
 if(condition.op==='in')return t('{path} is one of [{values}]',{path,values:(condition.value as ConditionScalar[]).map(scalar).join(', ')})
 const operators={eq:'=',neq:'≠',gt:'>',gte:'≥',lt:'<',lte:'≤',contains:t('contains')}
 return `${path} ${operators[condition.op]} ${scalar(condition.value as ConditionScalar)}`
}
