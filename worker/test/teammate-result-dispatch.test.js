import {env} from 'cloudflare:test';
import {expect,test} from 'vitest';
import {settleRun} from '../src/teammates.js';
import {drainTeammateResults} from '../src/teammateResultDispatch.js';
import {postMessage} from '../src/channels.js';
const run={id:'remote-run',org_id:'org',provider:'claude',channel:'b:room',thread_id:'thread',started_by:'alice',turn_version:0,updated_at:'2026-10-24T00:00:00Z'};
const read={texts:['Completed remote result'],stop:'end_turn',last:'event',costCents:40};
async function seed(){
 await env.DB.prepare("INSERT INTO channel_messages(id,org_id,channel,author_login,kind,body,created_at) VALUES ('thread','org','b:room','alice','message','Request','2026-10-24')").run();
 await env.DB.prepare("INSERT INTO ai_teammate_runs(id,org_id,provider,channel,thread_id,remote_id,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,'remote','running',?6,?6)").bind(run.id,run.org_id,run.provider,run.channel,run.thread_id,run.updated_at).run();
}
const settle=()=>settleRun(env.DB,run,read,new Date('2026-10-24T01:00:00Z'),{deliveryAgentId:'agent'});
const publish=async payload=>({published:Boolean((await postMessage(env.DB,{orgId:payload.run.org_id,key:payload.run.channel,authorLogin:`agent:${payload.agentId}`,kind:'agent',parentId:payload.run.thread_id,body:payload.read.texts.join('\n\n'),clientId:`tmp-${payload.deliveryId}`})).row)});
test('failed completion outbox insertion rolls remote settlement back atomically',async()=>{
 await seed();await env.DB.exec("CREATE TRIGGER fail_delivery BEFORE INSERT ON ai_teammate_result_dispatch BEGIN SELECT RAISE(ABORT,'test failure'); END;");
 await expect(settle()).rejects.toThrow();
 expect(await env.DB.prepare('SELECT status,result_delivery_id,last_event_at FROM ai_teammate_runs WHERE id=?1').bind(run.id).first()).toEqual({status:'running',result_delivery_id:null,last_event_at:null});
});
test('completed result retries local publication and clears payload after acknowledgement',async()=>{
 await seed();expect(await settle()).toBe('idle');expect(await settle()).toBeNull();
 expect((await env.DB.prepare('SELECT * FROM ai_teammate_result_dispatch').all()).results).toHaveLength(1);
 expect(await drainTeammateResults(env,async()=>{throw Error('database unavailable')},{now:100000})).toEqual({published:0,cancelled:0,retried:1});
 expect(await drainTeammateResults(env,publish,{now:120000})).toEqual({published:1,cancelled:0,retried:0});
 expect(await env.DB.prepare('SELECT status,payload FROM ai_teammate_result_dispatch').first()).toEqual({status:'published',payload:null});
 expect((await env.DB.prepare("SELECT * FROM channel_messages WHERE kind='agent'").all()).results).toHaveLength(1);
});
test('lost delivery acknowledgement retries without duplicating a posted reply',async()=>{
 await seed();await settle();
 await env.DB.exec("CREATE TRIGGER fail_ack BEFORE UPDATE ON ai_teammate_result_dispatch WHEN NEW.status='published' BEGIN SELECT RAISE(ABORT,'test failure'); END;");
 await expect(drainTeammateResults(env,publish,{now:100000})).rejects.toThrow();
 expect((await env.DB.prepare("SELECT * FROM channel_messages WHERE kind='agent'").all()).results).toHaveLength(1);
 await env.DB.exec('DROP TRIGGER fail_ack');
 expect(await drainTeammateResults(env,publish,{now:170000})).toEqual({published:1,cancelled:0,retried:0});
 expect((await env.DB.prepare("SELECT * FROM channel_messages WHERE kind='agent'").all()).results).toHaveLength(1);
});

test('proxy proposals stay outside reply retries until their actions are idempotent',async()=>{
 await seed();expect(await settleRun(env.DB,{...run,on_behalf_of:'alice'},read,new Date(),{deliveryAgentId:'agent'})).toBe('idle');
 expect((await env.DB.prepare('SELECT * FROM ai_teammate_result_dispatch').all()).results).toHaveLength(0);
});
