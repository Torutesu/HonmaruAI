import { env } from 'cloudflare:test';
import { fetchMock } from './helpers/fetch-mock.js';
import { beforeEach,afterEach,test,expect } from 'vitest';
import worker from '../src/index.js';
import { createSession,upsertUser,upsertMembership } from '../src/db.js';
import { generateAction,connectionEndpoint } from '../src/harness/appCapabilities.js';
const orgId='personal:company';let owner,member,app;
const call=(path,token,body)=>worker.fetch(new Request('https://example.com'+path+(body?'':`${path.includes('?')?'&':'?'}orgId=${orgId}`),{method:body?'POST':'GET',headers:{'content-type':'application/json','x-session-token':token},...(body?{body:JSON.stringify({orgId,...body})}:{})}),{...env});
const run=(sub,body,token=owner)=>call(`/apps/${app.id}/${sub}`,token,body);
beforeEach(async()=>{
 for(const [id,role] of [['1','admin'],['2','member']]){await upsertUser(env.DB,{githubId:id,login:'user'+id,name:id});await upsertMembership(env.DB,orgId,id,role);}
 owner=await createSession(env.DB,'1','gho1');member=await createSession(env.DB,'2','gho2');
 app=(await (await call('/apps',owner,{name:'Tasks',columns:[{name:'Task',type:'text'}]})).json()).app;
});
afterEach(()=>fetchMock.deactivate());
test('migration replay, conflict, partial failure and private entity ACL',async()=>{
 const operations=[{op:'create_entity',entity:'customers',name:'Customers',columns:[{name:'Name',type:'text'}]},{op:'add_columns',entity:'primary',columns:[{name:'Amount',type:'number'}]}];
 const req={action:'migrate',id:'customers_v1',version:0,operations};
 expect((await run('database',req,member)).status).toBe(403);
 expect(await (await run('database',req)).json()).toMatchObject({applied:true,version:1});
 expect(await (await run('database',req)).json()).toMatchObject({replay:true,version:1});
 expect((await run('database',{...req,operations:operations.slice(0,1)})).status).toBe(409);
 expect((await run('database',{...req,id:'another'})).status).toBe(409);
 const data=await (await run('database')).json();expect(data.entities).toHaveLength(2);expect(data.entities[0].table.columns).toHaveLength(2);
 const table=data.entities.find(e=>e.key==='customers').table;
 expect((await call('/tables/'+table.id,member)).status).toBe(200);
 await worker.fetch(new Request(`https://example.com/apps/${app.id}/access`,{method:'PUT',headers:{'content-type':'application/json','x-session-token':owner},body:JSON.stringify({orgId,version:0,visibility:'private'})}),{...env});
 expect((await call('/tables/'+table.id,member)).status).toBe(404);
 expect((await run('database',undefined,member)).status).toBe(404);
 expect((await run('database',{action:'migrate',id:'bad',version:1,operations:[{op:'create_entity',entity:'new_entity',name:'New',columns:[{name:'Name'}]},{op:'drop_entity',entity:'primary'}]})).status).toBe(400);
 expect((await (await run('database')).json()).entities).toHaveLength(2);
});
test('private preview writes never affect production and reject stale or invalid data',async()=>{
 const {fork}=await (await run('database',{action:'fork'})).json();
 const req={action:'fork_write',forkId:fork.id,revision:fork.revision,entity:'primary',operation:'create',values:{task:'preview only'}};
 expect((await run('database',req)).status).toBe(200);expect((await run('database',req)).status).toBe(409);
 expect((await (await call('/tables/'+app.tableId,owner)).json()).rows).toEqual([]);
 expect((await (await run('database',undefined,member)).json()).fork).toBeNull();
 expect((await run('database',{...req,revision:2,values:{unknown:'x'}})).status).toBe(400);
 expect((await run('database',req,member)).status).toBe(403);
});
test('action publication, exact revision, idempotency and app/caller job isolation',async()=>{
 const draft={action:'draft',name:'sum',version:0,code:'return input.a + input.b'};
 expect((await run('actions',draft,member)).status).toBe(403);expect((await run('actions',draft)).status).toBe(200);
 const g=await (await call('/gateways',owner,{name:'Mac mini'})).json();
 const req={action:'run',name:'sum',version:2,gatewayId:g.gateway.id,input:{a:20,b:22},requestId:'run1'};
 expect((await run('actions',req)).status).toBe(404);
 expect((await run('actions',{action:'publish',name:'sum',version:1})).status).toBe(200);
 expect((await run('actions',{...req,version:1})).status).toBe(409);
 const {job}=await (await run('actions',req)).json();expect(job.status).toBe('queued');
 expect((await (await run('actions',req)).json()).job.id).toBe(job.id);
 expect((await run('actions',{...req,input:{a:1}})).status).toBe(409);
 expect((await run('actions?jobId='+job.id,undefined,member)).status).toBe(404);
 const b=(await (await call('/apps',owner,{name:'Other',columns:[{name:'X'}]})).json()).app;
 expect((await call(`/apps/${b.id}/actions?jobId=${job.id}`,owner)).status).toBe(404);
 expect((await run('actions',{action:'draft',name:'sum',version:2,code:'return 100'})).status).toBe(200);
 expect((await (await run('actions')).json()).actions[0].published).toBe(draft.code);
 expect(JSON.parse((await env.DB.prepare('SELECT payload FROM hx_gateway_jobs WHERE id=?1').bind(job.id).first()).payload).code).toBe(draft.code);
});
test('personal exact endpoint proxy refuses unsafe URLs, redirects and revoked connections',async()=>{
 for(const u of ['http://api.github.com/user','https://127.0.0.1/x','https://api.github.com.evil.test/x','https://api.github.com:8443/x','https://api.github.com/user?token=x','https://slack.com/api/chat.postMessage'])expect(connectionEndpoint(u)).toBeNull();
 const conf={action:'save',name:'github',version:0,endpoint:'https://api.github.com/repos/Torutesu/HonmaruAI'};
 expect((await run('connections',conf)).status).toBe(200);
 expect((await (await run('connections',undefined,member)).json()).connections).toEqual([]);
 expect((await run('connections',{action:'request',name:'github',version:1},member)).status).toBe(404);
 expect((await run('connections',{action:'request',name:'github',version:0})).status).toBe(409);
 fetchMock.activate();
 fetchMock.get('https://api.github.com').intercept({path:'/repos/Torutesu/HonmaruAI',method:'GET'}).reply(200,{name:'HonmaruAI'},{headers:{'content-type':'application/json'}});
 expect(await (await run('connections',{action:'request',name:'github',version:1})).json()).toEqual({data:{name:'HonmaruAI'}});
 fetchMock.get('https://api.github.com').intercept({path:'/repos/Torutesu/HonmaruAI',method:'GET'}).reply(302,'',{headers:{location:'https://evil.test'}});
 expect((await run('connections',{action:'request',name:'github',version:1})).status).toBe(502);
 expect((await run('connections',{...conf,version:1,enabled:false})).status).toBe(200);
 expect((await run('connections',{action:'request',name:'github',version:2})).status).toBe(404);
});
test('generation errors fail closed',async()=>{
 expect((await generateAction('sum',null)).status).toBe(503);
 expect(await generateAction('sum',async()=>'{"name":"sum","code":"return input.a + input.b"}')).toMatchObject({name:'sum'});
 expect((await generateAction('sum',async()=>'not json')).status).toBe(502);
 const wrapped=await generateAction('sum',async()=>JSON.stringify({name:'sum',code:'async function sum(input) { return input.a + input.b; }'}));
 expect(wrapped.code).toBe('return await (async function sum(input) { return input.a + input.b; })(input);');
});

test('revoked app access prevents a queued server action from being claimed',async()=>{
 await run('actions',{action:'draft',name:'sum',version:0,code:'return input'});
 await run('actions',{action:'publish',name:'sum',version:1});
 const g=await (await call('/gateways',owner,{name:'Mac'})).json();
 const result=await (await run('actions',{action:'run',name:'sum',version:2,gatewayId:g.gateway.id,input:42,requestId:'r'},member)).json();
 await worker.fetch(new Request(`https://example.com/apps/${app.id}/access`,{method:'PUT',headers:{'content-type':'application/json','x-session-token':owner},body:JSON.stringify({orgId,version:0,visibility:'private'})}),{...env});
 const claim=await worker.fetch(new Request('https://example.com/gateways/claim',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+g.token},body:'{}'}),{...env});
 expect(await claim.json()).toEqual({job:null});
 expect((await env.DB.prepare('SELECT status FROM hx_gateway_jobs WHERE id=?1').bind(result.job.id).first()).status).toBe('failed');
 expect((await call('/gateways/jobs/'+result.job.id,member)).status).toBe(404);
 const original=await env.DB.prepare('SELECT request_id FROM hx_gateway_jobs WHERE id=?1').bind(result.job.id).first();
 expect((await call('/gateways/jobs',member,{gatewayId:g.gateway.id,code:'return input',input:42,requestId:original.request_id})).status).toBe(404);
});
test('secrets require encryption, are omitted from responses, and clear on origin change',async()=>{
 const req={action:'save',name:'private_api',version:0,endpoint:'https://api.github.com/user',token:'secret-value'};
 const response=await run('connections',req);
 // This fixture has no DATA_KEY; production must never store plaintext on a missing-key deployment.
 expect(response.status).toBe(503);
 expect((await (await run('connections')).json()).connections).toEqual([]);
});

test('agent and MCP calls use published actions and recheck app visibility',async()=>{
 const {callExecutionTool}=await import('../src/harness/executionTools.js');
 const {HARNESS_TOOL_SCOPE}=await import('../src/harness/mcpTools.js');
 await env.DB.prepare("INSERT INTO org_settings (org_id,mode,updated_at) VALUES (?1,'harness','now')").bind(orgId).run();
 await run('actions',{action:'draft',name:'sum',version:0,code:'return input'});await run('actions',{action:'publish',name:'sum',version:1});
 const actor={orgId,githubId:'2'};
 const found=await callExecutionTool(env,actor,'list_app_actions',{});expect(found.structuredContent.apps[0].actions[0].publishedVersion).toBe(2);
 expect(HARNESS_TOOL_SCOPE.run_app_action).toBe('execute');
 await worker.fetch(new Request(`https://example.com/apps/${app.id}/access`,{method:'PUT',headers:{'content-type':'application/json','x-session-token':owner},body:JSON.stringify({orgId,version:0,visibility:'private'})}),{...env});
 expect((await callExecutionTool(env,actor,'list_app_actions',{})).structuredContent.apps).toEqual([]);
 expect((await callExecutionTool(env,actor,'run_app_action',{appId:app.id})).isError).toBe(true);
});

test('encrypted credentials are context-bound and cleared when the API origin changes',async()=>{
 const {useSecretKey,isSealed}=await import('../src/secrets.js');
 const {saveConnection,connections}=await import('../src/harness/appCapabilities.js');
 useSecretKey({...env,DATA_KEY:btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))});
 try {
  expect(await saveConnection(env.DB,orgId,app.id,'1',{name:'service',version:0,endpoint:'https://api.github.com/user',token:'test-credential'})).toMatchObject({saved:true});
  const row=await env.DB.prepare('SELECT token FROM hx_app_connections WHERE app_id=?1').bind(app.id).first();expect(isSealed(row.token)).toBe(true);expect(row.token).not.toContain('test-credential');
  expect(JSON.stringify(await connections(env.DB,orgId,app.id,'1'))).not.toContain('test-credential');
  expect(await saveConnection(env.DB,orgId,app.id,'1',{name:'service',version:1,endpoint:'https://api.notion.com/v1/users/me'})).toMatchObject({saved:true});
  expect((await env.DB.prepare('SELECT token FROM hx_app_connections WHERE app_id=?1').bind(app.id).first()).token).toBeNull();
 }finally{useSecretKey({});}
});

test('external writes are constrained to the approved method/path and never replayed after uncertain failures',async()=>{
 const endpoint='https://api.github.com/repos/owner/repo/issues';
 expect((await run('connections',{action:'save',name:'issues',version:0,endpoint,method:'POST'})).status).toBe(200);
 expect(connectionEndpoint('https://www.googleapis.com/compute/v1/projects/x','POST')).toBeNull();
 fetchMock.activate();
 let calls=0;
 fetchMock.get('https://api.github.com').intercept({path:'/repos/owner/repo/issues',method:'POST'}).reply(201,opts=>{calls++;expect(JSON.parse(opts.body)).toEqual({title:'Test only'});return {number:1};},{headers:{'content-type':'application/json'}});
 const req={action:'request',name:'issues',version:1,requestId:'write1',body:{title:'Test only'}};
 expect((await run('connections',req)).status).toBe(200);
 expect((await run('connections',req)).status).toBe(409);expect(calls).toBe(1);
 fetchMock.get('https://api.github.com').intercept({path:'/repos/owner/repo/issues',method:'POST'}).replyWithError(new Error('network failure'));
 expect((await run('connections',{...req,requestId:'write2'})).status).toBe(502);
 expect((await run('connections',{...req,requestId:'write2'})).status).toBe(409);
 expect((await env.DB.prepare("SELECT status FROM hx_app_connection_requests WHERE request_id='write2'").first()).status).toBe('unknown');
});
