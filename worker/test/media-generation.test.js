import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import {upsertMembership,upsertUser} from '../src/db.js';
import {saveAISettings} from '../src/orgAI.js';
import {prepareImageGeneration,approveImageGeneration,readImageGeneration,claimImageGenerationJob,runImageGenerationJob,decorateImageGeneration} from '../src/harness/mediaGeneration.js';

const ORG='personal:media-generation',OWNER='9301',OTHER='9302',SCOPE='ag:media-agent|mediaowner';
beforeEach(async()=>{
 const now=new Date().toISOString();
 for(const [id,login,role] of [[OWNER,'mediaowner','admin'],[OTHER,'other','member']]){
  await upsertUser(env.DB,{githubId:id,login,name:login,avatarUrl:null,locale:'en'});
  await upsertMembership(env.DB,ORG,id,role);
 }
 await env.DB.prepare("INSERT INTO org_settings(org_id,mode,updated_at) VALUES(?1,'harness',?2)").bind(ORG,now).run();
 await env.DB.prepare(`INSERT INTO custom_agents(org_id,id,handle,name,instructions,scope,owner_login,created_at,updated_at)
  VALUES(?1,'media-agent','media','Media','Make images','personal','mediaowner',?2,?2)`).bind(ORG,now).run();
 await saveAISettings(env.DB,ORG,{openaiKey:'sk-workspace-media-abcdefghijkl'},OWNER);
});

test('image jobs stay private, idempotent, unqueued until confirmed, and claim with a hashed lease',async()=>{
 const first=await prepareImageGeneration(env.DB,ORG,OWNER,{scope:SCOPE,requestId:'req-1',prompt:'A mountain at dawn'});
 expect(first.job).toMatchObject({status:'awaiting_approval',model:'gpt-image-2.6-flare',fileId:null,estimate:{amountMicros:null}});
 expect((await prepareImageGeneration(env.DB,ORG,OWNER,{scope:SCOPE,requestId:'req-1',prompt:'A mountain at dawn'})).job.id).toBe(first.job.id);
 expect((await prepareImageGeneration(env.DB,ORG,OWNER,{scope:SCOPE,requestId:'req-1',prompt:'A different prompt'})).status).toBe(409);
 expect((await readImageGeneration(env.DB,ORG,OTHER,first.job.id)).status).toBe(404);
 expect((await approveImageGeneration(env.DB,ORG,OWNER,first.job.id,123)).status).toBe(409);
 expect(await claimImageGenerationJob(env.DB)).toBeNull();
 expect((await approveImageGeneration(env.DB,ORG,OWNER,first.job.id,null)).job.status).toBe('queued');
 const claimed=await claimImageGenerationJob(env.DB,{at:Date.now()});
 expect(claimed.job.status).toBe('running');
 expect(claimed.job.lease_hash).toHaveLength(64);
 expect(claimed.lease).not.toBe(claimed.job.lease_hash);
 await env.DB.prepare("UPDATE hx_media_generation_jobs SET status='succeeded',file_id='file-test',file_version=1 WHERE id=?1").bind(first.job.id).run();
 const ready=(await readImageGeneration(env.DB,ORG,OWNER,first.job.id)).job;
 const decorated=await decorateImageGeneration({...env,APP_WEB_URL:'https://honmaru.example'},ready,{orgId:ORG,userId:OWNER});
 expect(decorated.openUrl).toContain('file=file-test');
 await env.DB.prepare('DELETE FROM memberships WHERE org_id=?1 AND user_github_id=?2').bind(ORG,OWNER).run();
 await env.DB.prepare("UPDATE hx_media_generation_jobs SET status='running',lease_hash=?2 WHERE id=?1").bind(first.job.id,claimed.job.lease_hash).run();
 await runImageGenerationJob(env,claimed.job,claimed.lease);
 expect((await env.DB.prepare('SELECT status,error_code FROM hx_media_generation_jobs WHERE id=?').bind(first.job.id).first())).toMatchObject({status:'failed',error_code:'permission_revoked'});
});

test('image preparation never falls back to deployment credentials',async()=>{
 await env.DB.prepare('DELETE FROM org_ai_settings WHERE org_id=?1').bind(ORG).run();
 const result=await prepareImageGeneration(env.DB,ORG,OWNER,{scope:SCOPE,requestId:'req-no-key',prompt:'Only prepare'});
 expect(result.status).toBe(409);
 expect(result.error).toMatch(/workspace-owned OpenAI key/);
});
