import {expect,test} from 'vitest';
import {normalizeWorkflowCondition as normalize,evaluateWorkflowCondition as evaluate} from '../src/harness/workflowConditions.js';
const leaf=(op,value,path=['input','amount'])=>({path,op,value});
test('typed decisions compose without coercion and retain immutable normalized definitions',()=>{
 const raw={all:[leaf('gte',20),{any:[leaf('eq','approved',['row','status']),leaf('eq',true,['steps','1','output'])]}]};
 const saved=normalize(raw).condition;raw.all[0].value=100;
 expect(evaluate(saved,{input:{amount:25},row:{status:'approved'}})).toBe(true);
 expect(evaluate(saved,{input:{amount:'25'},row:{status:'approved'}})).toBe(false);
 expect(evaluate(saved,{input:{amount:25},steps:{1:{output:true}}})).toBe(true);
 expect(evaluate(leaf('neq',20),{input:{amount:'21'}})).toBe(false);
});
test('missing, null, zero and false have distinct existence and equality semantics',()=>{
 for(const value of [null,0,false,''])expect(evaluate(leaf('exists',true),{input:{amount:value}})).toBe(true);
 expect(evaluate(leaf('exists',false),{input:{}})).toBe(true);
 expect(evaluate(leaf('eq',null),{input:{}})).toBe(false);
 expect(evaluate(leaf('eq',null),{input:{amount:null}})).toBe(true);
 expect(evaluate(leaf('neq',20),{input:{}})).toBe(false);
 expect(evaluate({not:leaf('exists',true)},{input:{}})).toBe(true);
});
test('list and text comparisons remain strict and prototype data cannot drive branches',()=>{
 expect(evaluate(leaf('in',[1,2]),{input:{amount:'1'}})).toBe(false);
 expect(evaluate(leaf('in',[1,2]),{input:{amount:1}})).toBe(true);
 expect(evaluate(leaf('contains','承認'),{input:{amount:'承認済み'}})).toBe(true);
 expect(evaluate(leaf('exists',true),{input:Object.create({amount:1})})).toBe(false);
 for(const key of ['constructor','prototype','__proto__'])expect(normalize(leaf('eq',1,['input',key])).error).toBeTruthy();
});
test('invalid and excessive predicates fail explicitly instead of quietly selecting a branch',()=>{
 let deep=leaf('eq',1);for(let i=0;i<9;i++)deep={not:deep};
 for(const raw of [deep,{all:[]},{any:Array(17).fill(leaf('eq',1))},{all:[leaf('eq',1)],not:leaf('eq',2)},leaf('gt','2'),leaf('eq',Infinity),leaf('unknown',1),leaf('in',Array(101).fill(1)),{...leaf('eq',1),code:'true'},leaf('eq',1,['secret','value'])]) {
  expect(normalize(raw).error).toBeTruthy();expect(()=>evaluate(raw,{})).toThrow();
 }
 expect(normalize({all:Array.from({length:16},()=>({all:Array(4).fill(leaf('eq',1))}))}).error).toBeTruthy();
});
