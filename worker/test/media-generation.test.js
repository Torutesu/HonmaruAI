import {env} from 'cloudflare:test';
import {beforeEach,expect,test} from 'vitest';
import {upsertMembership,upsertUser} from '../src/db.js';
import {saveAISettings} from '../src/orgAI.js';
import {prepareImageGeneration,approveImageGeneration,readImageGeneration,claimImageGenerationJob,runImageGenerationJob,decorateImageGeneration,expireImageGenerationJobs,cancelImageGeneration} from '../src/harness/mediaGeneration.js';

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

test('approved image is stored as a private versioned file and completed jobs are not dispatched twice',async()=>{
 const prepared=await prepareImageGeneration(env.DB,ORG,OWNER,{scope:SCOPE,requestId:'req-success',prompt:'A tiny blue square'});
 await approveImageGeneration(env.DB,ORG,OWNER,prepared.job.id,null);
 const claim=await claimImageGenerationJob(env.DB);expect(claim.job.id).toBe(prepared.job.id);
 const originalFetch=globalThis.fetch;
 let providerRequest;
 globalThis.fetch=async(url,init)=>{
  providerRequest={url:String(url),headers:init.headers,body:JSON.parse(init.body)};
  return new Response(JSON.stringify({data:[{b64_json:btoa(String.fromCharCode(137,80,78,71,13,10,26,10))}]}),{status:200,headers:{'content-type':'application/json','x-request-id':'req-provider-1'}});
 };
 try { await runImageGenerationJob(env,claim.job,claim.lease); }
 finally { globalThis.fetch=originalFetch; }
 expect(providerRequest).toBeDefined();
 const result=(await readImageGeneration(env.DB,ORG,OWNER,prepared.job.id)).job;
 expect(providerRequest).toMatchObject({url:'https://api.openai.com/v1/images/generations',headers:{'idempotency-key':`honmaru-image-${prepared.job.id}`},body:{model:'gpt-image-2.6-flare',size:'1024x1024',quality:'low'}});
 expect(result).toMatchObject({status:'succeeded',fileId:`file-${prepared.job.id}`,fileVersion:1});
 const version=await env.DB.prepare('SELECT content_type,size FROM hx_workspace_file_versions WHERE org_id=?1 AND file_id=?2 AND version=1').bind(ORG,result.fileId).first();
 expect(version).toMatchObject({content_type:'image/png',size:8});
 const file=await env.DB.prepare('SELECT scope,created_by FROM hx_workspace_files WHERE org_id=?1 AND id=?2').bind(ORG,result.fileId).first();
 expect(file).toEqual({scope:SCOPE,created_by:OWNER});
 expect(await claimImageGenerationJob(env.DB)).toBeNull();
});

test('provider rejection is terminal and ambiguous failures expire as unknown without replay',async()=>{
 const prepared=await prepareImageGeneration(env.DB,ORG,OWNER,{scope:SCOPE,requestId:'req-error',prompt:'Do not retry me'});
 await approveImageGeneration(env.DB,ORG,OWNER,prepared.job.id,null);
 const claim=await claimImageGenerationJob(env.DB);
 const originalFetch=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({error:{message:'bad prompt'}}),{status:400});
 try { await runImageGenerationJob(env,claim.job,claim.lease); }
 finally { globalThis.fetch=originalFetch; }
 expect((await readImageGeneration(env.DB,ORG,OWNER,prepared.job.id)).job).toMatchObject({status:'failed',errorCode:'provider_rejected'});
 expect(await claimImageGenerationJob(env.DB)).toBeNull();

 const uncertain=await prepareImageGeneration(env.DB,ORG,OWNER,{scope:SCOPE,requestId:'req-unknown',prompt:'Maybe dispatched'});
 await approveImageGeneration(env.DB,ORG,OWNER,uncertain.job.id,null);
 const uncertainClaim=await claimImageGenerationJob(env.DB);
 await env.DB.prepare("UPDATE hx_media_generation_jobs SET lease_until=?2,deadline=?2 WHERE id=?1").bind(uncertain.job.id,Date.now()-1).run();
 await expireImageGenerationJobs(env.DB,Date.now());
 expect((await readImageGeneration(env.DB,ORG,OWNER,uncertain.job.id)).job).toMatchObject({status:'failed',errorCode:'outcome_unknown'});
 expect(await claimImageGenerationJob(env.DB)).toBeNull();
 expect(uncertainClaim.lease).not.toBe(uncertainClaim.job.lease_hash);
});

test('members can cancel only unstarted image requests',async()=>{
 const prepared=await prepareImageGeneration(env.DB,ORG,OWNER,{scope:SCOPE,requestId:'req-cancel',prompt:'Stop before dispatch'});
 expect((await cancelImageGeneration(env.DB,ORG,OWNER,prepared.job.id)).job.status).toBe('cancelled');
 expect(await claimImageGenerationJob(env.DB)).toBeNull();
});
