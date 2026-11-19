import { env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, test } from 'vitest';
import { fetchMock } from './helpers/fetch-mock.js';
import worker from '../src/index.js';
import { createSession, upsertMembership, upsertUser, upsertBusiness } from '../src/db.js';

const ORG='harness-teammate-private';
let ownerToken,memberToken;
const pending=[];
const ctx={waitUntil:p=>pending.push(p)};
const settle=async()=>{while(pending.length)await pending.shift()};
const call=async(path,init,extra={})=>{const response=await worker.fetch(new Request(`https://example.com${path}`,init),{...env,OPENAI_API_KEY:undefined,...extra},ctx);await settle();return response};
const headers=token=>({'content-type':'application/json','x-session-token':token});
const send=(method,path,token,body,extra)=>call(path,{method,headers:headers(token),body:JSON.stringify(body)},extra);
const get=(path,token)=>call(path,{headers:headers(token)});
const query=value=>new URLSearchParams(value).toString();

beforeEach(async()=>{
 for(const [id,login,name,role] of [['9751','owner','Owner','admin'],['9752','member','Member','member']]){
  await upsertUser(env.DB,{githubId:id,login,name,avatarUrl:null,locale:'en'});
  await upsertMembership(env.DB,ORG,id,role);
 }
 await upsertBusiness(env.DB,ORG,{name:'Ops',createdBy:'9751'});
 ownerToken=await createSession(env.DB,'9751','gho_owner');
 memberToken=await createSession(env.DB,'9752','gho_member');
 fetchMock.activate();
});
afterEach(()=>fetchMock.assertNoPendingInterceptors());

test('Harness external teammate creation is private until selected-member access is granted and revoked',async()=>{
 const {setMode}=await import('../src/harness/mode.js');
 await setMode(env.DB,ORG,'harness','9751');
 const registered=await send('POST','/gateways',ownerToken,{orgId:ORG,name:'Mac mini'});
 expect(registered.status).toBe(201);const {gateway,token}=await registered.json();
 await worker.fetch(new Request('https://example.com/gateways/claim',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({capabilities:['acp-v1'],acpAgents:['codex-local']})}),env,ctx);
 expect((await send('PUT','/teammates',ownerToken,{orgId:ORG,provider:'acp',enabled:true,gatewayId:gateway.id,agentKey:'codex-local'})).status).toBe(200);

 const agent=await env.DB.prepare("SELECT id,scope,owner_login FROM custom_agents WHERE org_id=?1 AND provider='acp'").bind(ORG).first();
 expect(agent).toMatchObject({scope:'personal',owner_login:'owner'});
 expect(await env.DB.prepare('SELECT access,people FROM hx_agent_profiles WHERE org_id=?1 AND agent_id=?2').bind(ORG,agent.id).first()).toEqual({access:'private',people:'[]'});
 expect((await (await get(`/channels/agents?${query({orgId:ORG})}`,memberToken)).json()).agents.some(row=>row.id===agent.id)).toBe(false);
 expect((await get(`/hx/agents/${agent.id}/members?${query({orgId:ORG})}`,memberToken)).status).toBe(404);
 expect((await send('PUT',`/hx/agents/${agent.id}/profile`,ownerToken,{orgId:ORG,access:'everyone'})).status).toBe(409);
 expect((await send('PUT',`/hx/agents/${agent.id}/profile`,ownerToken,{orgId:ORG,access:'people',people:['member']})).status).toBe(409);

 const access=await (await get(`/hx/agents/${agent.id}/members?${query({orgId:ORG})}`,ownerToken)).json();
 expect(access).toMatchObject({scope:'personal',version:0});
 const memberRef=access.candidates.find(person=>person.name==='Member')?.ref;
 expect(memberRef).toBeTruthy();
 expect((await send('PUT',`/hx/agents/${agent.id}/members`,ownerToken,{orgId:ORG,ref:memberRef,role:'member',expectedVersion:access.version})).status).toBe(200);
 expect(await env.DB.prepare('SELECT scope FROM custom_agents WHERE org_id=?1 AND id=?2').bind(ORG,agent.id).first()).toEqual({scope:'team'});
 expect(await env.DB.prepare('SELECT access FROM hx_agent_profiles WHERE org_id=?1 AND agent_id=?2').bind(ORG,agent.id).first()).toEqual({access:'private'});
 expect((await (await get(`/channels/agents?${query({orgId:ORG})}`,memberToken)).json()).agents.some(row=>row.id===agent.id)).toBe(true);

 const updated=await (await get(`/hx/agents/${agent.id}/members?${query({orgId:ORG})}`,ownerToken)).json();
 expect((await send('PUT',`/hx/agents/${agent.id}/members`,ownerToken,{orgId:ORG,ref:memberRef,role:'none',expectedVersion:updated.version})).status).toBe(200);
 expect((await (await get(`/channels/agents?${query({orgId:ORG})}`,memberToken)).json()).agents.some(row=>row.id===agent.id)).toBe(false);
});

test('a new Simple-mode external teammate keeps the existing workspace-shared behavior',async()=>{
 const registered=await send('POST','/gateways',ownerToken,{orgId:ORG,name:'Mac mini'});
 const {gateway,token}=await registered.json();
 await worker.fetch(new Request('https://example.com/gateways/claim',{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/json'},body:JSON.stringify({capabilities:['acp-v1'],acpAgents:['codex-local']})}),env,ctx);
 expect((await send('PUT','/teammates',ownerToken,{orgId:ORG,provider:'acp',enabled:true,gatewayId:gateway.id,agentKey:'codex-local'})).status).toBe(200);
 const agent=await env.DB.prepare("SELECT id,scope FROM custom_agents WHERE org_id=?1 AND provider='acp'").bind(ORG).first();
 expect(agent.scope).toBe('team');
 expect(await env.DB.prepare('SELECT 1 FROM hx_agent_profiles WHERE org_id=?1 AND agent_id=?2').bind(ORG,agent.id).first()).toBeNull();
 expect((await (await get(`/channels/agents?${query({orgId:ORG})}`,memberToken)).json()).agents.some(row=>row.id===agent.id)).toBe(true);
});
