import { env } from 'cloudflare:test';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import schemaSql from '../schema.sql?raw';
import worker from '../src/index.js';
import { refreshConnectedGitDrafts } from '../src/harness/githubDraftWatcher.js';
import { createSession, upsertMembership, upsertUser } from '../src/db.js';

const ORG='personal:git-draft-watch';
const HTML_SHA='a'.repeat(40), TREE_SHA='b'.repeat(40), COMMIT_SHA='c'.repeat(40);
let session;
const headers=token=>({'content-type':'application/json','x-session-token':token});
const call=(path,init={})=>worker.fetch(new Request('https://example.com'+path,init),{...env});
const send=(method,path,token,body)=>call(path,{method,headers:headers(token),body:JSON.stringify({orgId:ORG,...body})});
const json=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'content-type':'application/json'}});
const base64=text=>btoa(unescape(encodeURIComponent(text)));

beforeEach(async()=>{
  await env.DB.exec(schemaSql.replace(/\n/g,' '));
  await upsertUser(env.DB,{githubId:'98101',login:'maker',name:'Maker',avatarUrl:null,locale:'en'});
  await upsertMembership(env.DB,ORG,'98101','admin');
  session=await createSession(env.DB,'98101','gho-auto-draft-test');
});
afterEach(()=>vi.unstubAllGlobals());

test('minute watcher imports only a new generated draft commit and leaves publication for the existing approval flow',async()=>{
  const appResponse=await send('POST','/apps',session,{template:'tracker',sample:false});
  expect(appResponse.status).toBe(201);
  const app=(await appResponse.json()).app;
  const requests=[];
  vi.stubGlobal('fetch',vi.fn(async(input,options={})=>{
    const url=new URL(String(input)),path=url.pathname;
    requests.push({path,method:options.method||'GET'});
    if(path==='/user')return json({id:98101,login:'maker'});
    if(path==='/repos/acme/demo')return json({full_name:'acme/demo',default_branch:'main',permissions:{push:true}});
    if(path===`/repos/acme/demo/git/ref/heads/honmaru/apps/${app.id}/draft`)return json({object:{sha:COMMIT_SHA}});
    if(path===`/repos/acme/demo/git/commits/${COMMIT_SHA}`)return json({sha:COMMIT_SHA,tree:{sha:TREE_SHA}});
    if(path===`/repos/acme/demo/git/trees/${TREE_SHA}`)return json({truncated:false,tree:[{type:'blob',mode:'100644',path:`honmaru/apps/${app.id}/draft/index.html`,sha:HTML_SHA,size:new TextEncoder().encode('<main>remote draft</main>').length}]});
    if(path===`/repos/acme/demo/git/blobs/${HTML_SHA}`)return json({encoding:'base64',sha:HTML_SHA,size:new TextEncoder().encode('<main>remote draft</main>').length,content:base64('<main>remote draft</main>')});
    return json({message:`unexpected ${path}`},404);
  }));
  const bound=await send('POST',`/apps/${app.id}/custom`,session,{action:'bind_git_repo',version:app.version,owner:'acme',repo:'demo'});
  expect(bound.status,await bound.clone().text()).toBe(200);
  const first=await refreshConnectedGitDrafts({...env,DB:env.DB},{now:Date.now(),limit:5});
  expect(first).toEqual({checked:1,imported:1,failed:0});
  const state=await env.DB.prepare(`SELECT version,json_extract(definition,'$.custom.draft') AS draft,
      json_extract(definition,'$.custom.gitDraft.headSha') AS head,
      json_extract(definition,'$.custom.published') AS published
    FROM hx_apps WHERE org_id=?1 AND id=?2`).bind(ORG,app.id).first();
  expect(state.version).toBe(app.version+2);
  expect(state.draft).toBe('<main>remote draft</main>');
  expect(state.head).toBe(COMMIT_SHA);
  expect(state.published).toBeNull();
  expect(requests.every(x=>x.method==='GET')).toBe(true);

  const second=await refreshConnectedGitDrafts({...env,DB:env.DB},{now:Date.now()+30_000,limit:5});
  expect(second).toEqual({checked:0,imported:0,failed:0});
  const third=await refreshConnectedGitDrafts({...env,DB:env.DB},{now:Date.now()+61_000,limit:5});
  expect(third).toEqual({checked:1,imported:0,failed:0});
  expect((await env.DB.prepare('SELECT version FROM hx_apps WHERE org_id=?1 AND id=?2').bind(ORG,app.id).first()).version).toBe(app.version+2);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_git_assets WHERE org_id=?1 AND app_id=?2').bind(ORG,app.id).first()).n).toBe(0);
  const watch=await env.DB.prepare('SELECT last_check_at,last_error,failures FROM hx_app_git_draft_watches WHERE org_id=?1 AND app_id=?2').bind(ORG,app.id).first();
  expect(watch).toMatchObject({last_error:null,failures:0});
  const unbound=await send('POST',`/apps/${app.id}/custom`,session,{action:'unbind_git_repo',version:app.version+2});
  expect(unbound.status,await unbound.clone().text()).toBe(200);
  expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_app_git_draft_watches WHERE org_id=?1 AND app_id=?2').bind(ORG,app.id).first()).n).toBe(0);
});

test('watcher pauses when the repository owner no longer has an active GitHub session',async()=>{
  const appResponse=await send('POST','/apps',session,{template:'tracker',sample:false});
  const app=(await appResponse.json()).app;
  vi.stubGlobal('fetch',vi.fn(async input=>{
    const path=new URL(String(input)).pathname;
    if(path==='/user')return json({id:98101,login:'maker'});
    if(path==='/repos/acme/demo')return json({full_name:'acme/demo',default_branch:'main',permissions:{push:true}});
    return json({},404);
  }));
  const bound=await send('POST',`/apps/${app.id}/custom`,session,{action:'bind_git_repo',version:app.version,owner:'acme',repo:'demo'});
  expect(bound.status).toBe(200);
  await env.DB.prepare('DELETE FROM sessions').run();
  const result=await refreshConnectedGitDrafts({...env,DB:env.DB},{now:Date.now()+5_000,limit:5});
  expect(result).toEqual({checked:1,imported:0,failed:1});
  const watch=await env.DB.prepare('SELECT last_error,failures FROM hx_app_git_draft_watches WHERE org_id=?1 AND app_id=?2').bind(ORG,app.id).first();
  expect(watch.last_error).toContain('Reconnect the GitHub account');
  expect(watch.failures).toBe(1);
});
