import {env} from 'cloudflare:test';
import {beforeEach, expect, test, vi} from 'vitest';
import {enqueueCardNotification, runCardNotification, drainCardNotifications, deliverOnce, MAX_ATTEMPTS} from '../src/notificationJobs.js';
import {upsertUser} from '../src/db.js';
const input = {card:{id:'retry-card',createdAt:'2026-10-01T00:00:00Z',senderUserID:'sender',recipientUserID:'reader',status:'pending',title:'Test'}, kind:'created'};
beforeEach(async()=>{ await upsertUser(env.DB,{githubId:'reader-id',login:'reader',name:'Reader',avatarUrl:null}); });
const job = async(id)=>(await env.DB.prepare('SELECT * FROM notification_jobs WHERE id = ?1').bind(id).first());
test('503 survives an invocation and retry skips already accepted destinations',async()=>{
 const id=await enqueueCardNotification(env,input);
 const a=vi.fn().mockResolvedValue({ok:true,status:200});
 const b=vi.fn().mockResolvedValueOnce({ok:false,status:503}).mockResolvedValue({ok:true,status:200});
 const send=async(_env,{deliveryJobId})=>{
  const one=await deliverOnce(env.DB,deliveryJobId,'apns','device-a',a);
  const two=await deliverOnce(env.DB,deliveryJobId,'apns','device-b',b);
  return {sent:Number(one.ok)+Number(two.ok),retry:!two.ok};
 };
 await runCardNotification(env,id,send);
 expect((await job(id)).state).toBe('pending');
 await runCardNotification(env,id,send,Date.now()+61_000);
 expect((await job(id)).state).toBe('sent');
 expect(a).toHaveBeenCalledTimes(1);expect(b).toHaveBeenCalledTimes(2);
 expect((await job(id)).payload).toBe('{}');
});
test('duplicate events and overlapping drains have one lease',async()=>{
 const id=await enqueueCardNotification(env,input);
 expect(await enqueueCardNotification(env,input)).toBe(id);
 const send=vi.fn().mockResolvedValue({sent:1});
 await Promise.all([runCardNotification(env,id,send),runCardNotification(env,id,send)]);
 expect(send).toHaveBeenCalledTimes(1);
});
test('caps retry attempts and retains a failure record without message content',async()=>{
 const id=await enqueueCardNotification(env,input);
 const send=vi.fn().mockRejectedValue(new Error('provider unreachable'));
 for(let n=0;n<MAX_ATTEMPTS;n++) await runCardNotification(env,id,send,Date.now()+n*3600001);
 expect((await job(id)).state).toBe('failed'); expect((await job(id)).attempts).toBe(MAX_ATTEMPTS);
 expect((await job(id)).payload).toBe('{}');
 await drainCardNotifications(env,send,Date.now()+6*3600001);
 expect(send).toHaveBeenCalledTimes(MAX_ATTEMPTS);
});
test('expired claims are recoverable after a worker crash',async()=>{
 const id=await enqueueCardNotification(env,input);
 await env.DB.prepare("UPDATE notification_jobs SET lease_until = '2020-01-01', attempts = 1 WHERE id = ?1").bind(id).run();
 const send=vi.fn().mockResolvedValue({sent:1});
 await drainCardNotifications(env,send);
 expect(send).toHaveBeenCalledOnce();expect((await job(id)).state).toBe('sent');
});
test('a removed recipient is not notified by a retry',async()=>{
 const id=await enqueueCardNotification(env,input);
 await runCardNotification(env,id,async()=>({sent:0,retry:true}));
 await env.DB.prepare("DELETE FROM users WHERE login = 'reader'").run();
 const send=vi.fn();await runCardNotification(env,id,send,Date.now()+61000);
 expect(send).not.toHaveBeenCalled();expect((await job(id)).state).toBe('skipped');
});
test('workspace access is rechecked before retrying private content',async()=>{
 const id=await enqueueCardNotification(env,{...input,orgId:'removed-workspace'});
 await runCardNotification(env,id,async()=>({sent:0,retry:true}));
 const send=vi.fn();await runCardNotification(env,id,send,Date.now()+61000);
 expect(send).not.toHaveBeenCalled();expect((await job(id)).state).toBe('skipped');
});
