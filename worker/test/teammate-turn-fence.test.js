import {env} from 'cloudflare:test';
import {expect,test} from 'vitest';
import {settleRun} from '../src/teammates.js';

const base={id:'remote-work',org_id:'org',provider:'claude',channel:'b:room',thread_id:'thread',remote_id:'remote',status:'running',updated_at:'2026-10-24T00:00:00Z',turn_version:0};
async function seed(){await env.DB.prepare("INSERT INTO ai_teammate_runs(id,org_id,provider,channel,thread_id,remote_id,status,created_at,updated_at) VALUES (?1,?2,?3,?4,?5,?6,'running',?7,?7)").bind(base.id,base.org_id,base.provider,base.channel,base.thread_id,base.remote_id,base.updated_at).run()}
const done={stop:'end_turn',last:'old-event',costCents:20};
test('an old external poll cannot finish or charge a newer turn in the same remote session',async()=>{
 await seed();await env.DB.prepare("UPDATE ai_teammate_runs SET turn_version=1,remote_turn='new-turn',cost_cents=50 WHERE id=?1").bind(base.id).run();
 expect(await settleRun(env.DB,base,done)).toBeNull();
 expect(await env.DB.prepare('SELECT status,turn_version,cost_cents,last_event_at FROM ai_teammate_runs WHERE id=?1').bind(base.id).first()).toEqual({status:'running',turn_version:1,cost_cents:50,last_event_at:null});
 expect(await settleRun(env.DB,{...base,turn_version:1},{...done,last:'new-event',costCents:70})).toBe('idle');
 expect(await settleRun(env.DB,{...base,turn_version:1},done)).toBeNull();
});
test('legacy turn zero settles once and a foreign workspace cannot settle it',async()=>{
 await seed();expect(await settleRun(env.DB,{...base,org_id:'other'},done)).toBeNull();
 const {turn_version,...legacy}=base;expect(await settleRun(env.DB,legacy,done)).toBe('idle');
 expect(await settleRun(env.DB,legacy,done)).toBeNull();
});
