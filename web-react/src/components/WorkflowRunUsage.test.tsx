import React from 'react'
import {renderToStaticMarkup} from 'react-dom/server'
import {expect,test,vi} from 'vitest'
import {WorkflowRunUsage} from './WorkflowRunUsage'
vi.mock('../utils/i18n',()=>({useT:()=>((s:string)=>s)}))
vi.mock('../utils/locale',()=>({getLocale:()=> 'en'}))
test('historical or absent measurements never claim zero spend',()=>{
 const html=renderToStaticMarkup(<WorkflowRunUsage usage={undefined}/>);
 expect(html).toContain('does not confirm zero usage');
 expect(html).not.toContain('Input tokens');
});
test('reported counters and unknown responses remain visibly distinct',()=>{
 const counters={calls:3,inputTokens:1200,outputTokens:40,unknownCalls:1,unpricedCalls:1,estimatedMicros:37};
 const html=renderToStaticMarkup(<WorkflowRunUsage usage={{...counters,coverage:'priced-token-estimate',estimatedUsd:0.000037,steps:[{...counters,stepNumber:2}]}}/>);
 expect(html).toContain('1,200');
 expect(html).toContain('Responses with unknown usage');
 expect(html).toContain('Unrecorded calls and external tool charges are not included');
 expect(html).toContain('Step 2');
});
