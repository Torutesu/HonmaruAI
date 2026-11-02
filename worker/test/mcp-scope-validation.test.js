import { env } from 'cloudflare:test';
import { beforeEach, expect, test } from 'vitest';
import schemaSql from '../schema.sql?raw';
import worker from '../src/index.js';

const ORG = 'personal:scope-validation';
let session;
const request = (path, init = {}) => worker.fetch(new Request(`https://example.com${path}`, init), env);
const postToken = (fields = {}) => request('/tokens', { method:'POST', headers:{'content-type':'application/json','x-session-token':session}, body: JSON.stringify({orgId:ORG,name:'Test',...fields}) });
const rpc = async (token, method, params) => (await request('/mcp',{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:JSON.stringify({jsonrpc:'2.0',id:1,method,params})})).json();

beforeEach(async () => {
  await env.DB.exec(schemaSql.replace(/\n/g,' '));
  const {upsertUser,upsertMembership,createSession}=await import('../src/db.js');
  await upsertUser(env.DB,{githubId:'scope-user',login:'scopeuser',name:'Scope User',avatarUrl:null,locale:'en'});
  await upsertMembership(env.DB,ORG,'scope-user','admin');
  session=await createSession(env.DB,'scope-user','scope-gh');
});

test('rejects explicitly non-array scopes before creating a token', async () => {
  for (const scopes of ['read',null,{},42,true]) {
    const response=await postToken({scopes});
    expect(response.status).toBe(400);
  }
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM api_tokens WHERE org_id = ?1').bind(ORG).first()).n).toBe(0);
});

test('unspecified and SQL NULL retain legacy read/write; a read-only token remains read-only', async () => {
  const legacy=await (await postToken()).json();
  expect(legacy.scopes).toEqual(['read','write']);
  await env.DB.prepare('UPDATE api_tokens SET scopes = NULL WHERE id = ?1').bind(legacy.id).run();
  expect((await rpc(legacy.token,'tools/list')).result.tools.map(t=>t.name)).toContain('request_decision');
  const read=await (await postToken({scopes:['read']})).json();
  expect((await rpc(read.token,'tools/list')).result.tools.map(t=>t.name)).not.toContain('request_decision');
  const list=await (await request(`/tokens?orgId=${encodeURIComponent(ORG)}`,{headers:{'x-session-token':session}})).json();
  expect(list.tokens.find(t=>t.id===legacy.id).scopes).toEqual(['read','write']);
});

test('invalid persisted scopes grant no tools and are distinguishable in the key listing', async () => {
  const made=await (await postToken({scopes:['read']})).json();
  for (const bad of ['', 'garbage', 'null', '"read"', '{}', '["read",42]', '["read","future-scope"]']) {
    await env.DB.prepare('UPDATE api_tokens SET scopes=?1 WHERE id=?2').bind(bad,made.id).run();
    expect((await rpc(made.token,'tools/list')).result.tools).toEqual([]);
    expect((await rpc(made.token,'tools/call',{name:'request_decision',arguments:{title:'unsafe'}})).result.isError).toBe(true);
    const listed=await (await request(`/tokens?orgId=${encodeURIComponent(ORG)}`,{headers:{'x-session-token':session}})).json();
    expect(listed.tokens.find(t=>t.id===made.id)).toMatchObject({scopes:[], invalidScopes:true});
  }
});

test('valid empty and unknown requested arrays retain their existing read-only fallback', async () => {
  for (const scopes of [[], ['not-a-scope']]) {
    const response=await postToken({scopes});
    expect(response.status).toBe(201);
    const made=await response.json();
    expect(made.scopes).toEqual(['read']);
    expect((await rpc(made.token,'tools/list')).result.tools.map(t=>t.name)).not.toContain('request_decision');
  }
});

test('an existing stored empty array preserves its read-only fallback', async () => {
  const made=await (await postToken({scopes:['read']})).json();
  await env.DB.prepare('UPDATE api_tokens SET scopes = ?1 WHERE id = ?2').bind('[]',made.id).run();
  const tools=(await rpc(made.token,'tools/list')).result.tools.map(t=>t.name);
  expect(tools).toContain('get_playbook');
  expect(tools).not.toContain('request_decision');
  const listed=await (await request(`/tokens?orgId=${encodeURIComponent(ORG)}`,{headers:{'x-session-token':session}})).json();
  expect(listed.tokens.find(t=>t.id===made.id)).toMatchObject({scopes:['read']});
});
