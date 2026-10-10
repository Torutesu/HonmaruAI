import {env} from 'cloudflare:test';
import {fetchMock} from './helpers/fetch-mock.js';
import {beforeEach, afterEach, expect, test} from 'vitest';
import {sendDuePushes} from '../src/pushes.js';
import {resetProviderToken} from '../src/apns.js';
import {upsertUser,upsertMembership,registerDevice} from '../src/db.js';
const TEST_P8 = `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgevZzL1gdAFr88hb2
OF/2NxApJCzGCEDdfSp6VQO30hyhRANCAAQRWz+jn65BtOMvdyHKcvjBeBSDZH2r
1RTwjmYSi9R/zpBnuQ4EiMnCqfMPWiZqB4QdbAd0E7oH50VpuZ1P087G
-----END PRIVATE KEY-----`;


const settings = () => ({...env, APNS_KEY_ID:'ABC1234567', APNS_TEAM_ID:'TEAM123456', APNS_TOPIC:'com.honmaru.ai', APNS_PRIVATE_KEY:TEST_P8, APNS_ENVIRONMENT:'sandbox'});
let now;
beforeEach(async()=>{
 resetProviderToken();fetchMock.activate();now=Date.now();
 for(const login of ['sender','reader']) {
  await upsertUser(env.DB,{githubId:login,login,name:login,avatarUrl:null});
  await upsertMembership(env.DB,'retry-org',login,'member');
 }
 for(const token of ['device-a','device-b']) await registerDevice(env.DB,{deviceToken:token,githubId:'reader',login:'reader',environment:'sandbox'});
 const at=new Date(now-120000).toISOString();
 await env.DB.prepare("INSERT INTO channel_messages (id,org_id,channel,author_login,body,kind,created_at) VALUES ('retry-message','retry-org','dm:reader|sender','sender','Test request','message',?1)").bind(at).run();
 await env.DB.prepare("INSERT INTO push_queue (org_id,login,message_id,reason,created_at,due_at) VALUES ('retry-org','reader','retry-message','direct',?1,?1)").bind(at).run();
});
afterEach(()=>fetchMock.assertNoPendingInterceptors());
const reply=(token,status)=>fetchMock.get('https://api.sandbox.push.apple.com').intercept({path:`/3/device/${token}`,method:'POST'}).reply(status,{});
test('message retries transient failures and does not resend to accepted devices',async()=>{
 reply('device-a',200);reply('device-b',503);
 expect(await sendDuePushes(settings(),now)).toEqual({sent:1,skipped:0});
 const first=await env.DB.prepare('SELECT * FROM push_queue').first();
 expect(first.sent_at).toBeNull();expect(first.attempts).toBe(1);
 reply('device-b',200);
 expect(await sendDuePushes(settings(),now+61000)).toEqual({sent:1,skipped:0});
 const final=await env.DB.prepare('SELECT * FROM push_queue').first();
 expect(final.sent_at).not.toBeNull();expect(final.attempts).toBe(2);
});
test('membership removal after failure prevents delivery on retry',async()=>{
 reply('device-a',503);reply('device-b',503);
 await sendDuePushes(settings(),now);
 await env.DB.prepare("DELETE FROM memberships WHERE org_id='retry-org' AND user_github_id='reader'").run();
 expect(await sendDuePushes(settings(),now+61000)).toEqual({sent:0,skipped:1});
});
