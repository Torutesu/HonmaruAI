import {expect,test} from 'vitest';
import {cleanWorkflowMessageDrafts} from '../src/harness/workflowMessageDrafts.js';

test('workflow draft messages preserve text and bounded mention metadata',()=>{
 expect(cleanWorkflowMessageDrafts([{text:'Report ready',mention:['mika','toru']},{text:'No mention'}])).toEqual([
  {text:'Report ready',mention:['mika','toru']},{text:'No mention'},
 ]);
});

test.each([
 null,
 Array.from({length:33},()=>({text:'x'})),
 [{text:' '}],
 [{text:'x'.repeat(12001)}],
 [{text:'x',channel:'room'}],
 [{text:'x',mention:['']}],
])('rejects malformed or oversized workflow drafts: %s',value=>{
 expect(()=>cleanWorkflowMessageDrafts(value)).toThrow();
});

test('bounds aggregate draft size independently from per-message size',()=>{
 expect(()=>cleanWorkflowMessageDrafts([{text:'a'.repeat(12000)},{text:'b'.repeat(12000)},{text:'c'.repeat(12000)}])).toThrow(/size limit/);
});
