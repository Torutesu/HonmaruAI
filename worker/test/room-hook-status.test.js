import {expect,test} from 'vitest';
import {roomHookStatuses} from '../src/harness/roomHookStatus.js';
const events=[{messageId:'one',hookId:'hook',createdAt:'2026-10-23',dispatchStatus:'accepted'}];
test('queue read failure remains unknown rather than reporting success',async()=>{
 const env={AGENT_RUNNER:{idFromName:id=>id,get:()=>({fetch:async()=>{throw Error('offline')}})}};
 expect((await roomHookStatuses(env,'org',events))[0].status).toBe('unknown');
});
test('finishing without a saved model answer differs from a saved reply',async()=>{
 const run=answered=>roomHookStatuses({AGENT_RUNNER:{idFromName:id=>id,get:()=>({fetch:async()=>Response.json({results:[{rowId:'one',status:'finished',answered}]})})}},'org',events);
 expect((await run(0))[0].status).toBe('finished');
 expect((await run(1))[0].status).toBe('answered');
});

test('an active external run takes priority over a finished dispatcher and survives runner lookup failure',async()=>{
 const external=[{...events[0],externalRuns:2,externalRunning:1,externalFailed:1}];
 const env={AGENT_RUNNER:{idFromName:id=>id,get:()=>({fetch:async()=>Response.json({results:[{rowId:'one',status:'finished',answered:1}]})})}};
 expect((await roomHookStatuses(env,'org',external))[0].status).toBe('external_running');
 expect((await roomHookStatuses({},'org',external))[0].status).toBe('external_running');
});
test('external completion does not imply a saved reply and failure is retained',async()=>{
 expect((await roomHookStatuses({},'org',[{...events[0],externalRuns:1,externalRunning:0,externalFailed:0}]))[0].status).toBe('external_finished');
 expect((await roomHookStatuses({},'org',[{...events[0],externalRuns:1,externalRunning:0,externalFailed:1}]))[0].status).toBe('external_failed');
 expect((await roomHookStatuses({},'org',[{...events[0],dispatchStatus:'cancelled',externalRuns:1,externalRunning:1}]))[0].status).toBe('cancelled');
});
