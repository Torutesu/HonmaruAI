import {env} from 'cloudflare:test';
import {beforeEach,test,expect} from 'vitest';
import worker from '../src/index.js';
import sql from '../workspace-files.sql?raw';
import {createSession,upsertUser,upsertMembership} from '../src/db.js';
const orgId='personal:file-http';let token,guest;
const call=(path,method='GET',body,session=token,raw=false)=>worker.fetch(new Request(`https://example.test${path}${path.includes('?')?'&':'?'}orgId=${orgId}`,{method,headers:{'x-session-token':session||'','content-type':raw?'text/plain':'application/json'},...(body===undefined?{}:{body:raw?body:JSON.stringify(body)})}),env);
beforeEach(async()=>{
 await env.DB.exec(sql.replace(/\n/g,' '));
 for(const [id,role] of [['file-human','admin'],['file-guest','guest']]){await upsertUser(env.DB,{githubId:id,login:id,name:id});await upsertMembership(env.DB,orgId,id,role);}
 token=await createSession(env.DB,'file-human','test');guest=await createSession(env.DB,'file-guest','test');
});
test('authenticated file HTTP routes preserve raw uploads and enforce versioned operations',async()=>{
 let response=await call('/hx/files','POST',{scope:'workspace',path:'http.txt'});expect(response.status).toBe(201);const {id}=await response.json();
 response=await call(`/hx/files/${id}/content?expectedVersion=0&size=5`,'PUT','hello',token,true);expect(response.status).toBe(200);
 response=await call(`/hx/files/${id}/versions/1/content`);expect(response.status).toBe(200);expect(await response.text()).toBe('hello');
 expect((await call(`/hx/files/${id}`,'DELETE',{expectedVersion:0})).status).toBe(409);
 expect((await call(`/hx/files/${id}`,'DELETE',{expectedVersion:1})).status).toBe(200);
 expect((await call(`/hx/files/${id}/restore`,'POST',{version:1,expectedVersion:2})).status).toBe(200);
 expect((await (await call('/hx/files?scope=workspace')).json()).files[0].version).toBe(3);
 expect((await env.DB.prepare("SELECT * FROM audit_events WHERE org_id=? AND action='workspace.file_changed'").bind(orgId).all()).results).toHaveLength(4);
});
test('file HTTP routes refuse missing sessions guests and a partial migration',async()=>{
 expect((await call('/hx/files?scope=workspace','GET',undefined,null)).status).toBe(401);
 expect((await call('/hx/files?scope=workspace','GET',undefined,guest)).status).toBe(403);
 await env.DB.prepare('DROP TABLE hx_file_account_erasures').run();
 expect((await call('/hx/files?scope=workspace')).status).toBe(503);
});

test('authenticated administrators cannot bypass private file scope or another workspace',async()=>{
 const {id}=await (await call('/hx/files','POST',{scope:'workspace',path:'private.txt'})).json();
 await call(`/hx/files/${id}/content?expectedVersion=0&size=5`,'PUT','hello',token,true);
 await env.DB.prepare('UPDATE hx_workspace_files SET scope=? WHERE org_id=? AND id=?').bind('g:closed',orgId,id).run();
 expect((await call(`/hx/files/${id}/versions/1/content`)).status).toBe(404);
 expect((await call(`/hx/files/${id}/content?expectedVersion=1&size=5`,'PUT','other',token,true)).status).toBe(409);
 expect((await (await call('/hx/files?scope=all')).json()).files).toEqual([]);
 expect((await call('/hx/files?scope=all&orgId=another-workspace')).status).toBe(403);
});

test('room file scope resolution rejects unavailable and foreign rooms',async()=>{
 for(const channel of ['b:missing','g:closed','ag:missing','dm:missing','workspace']){
  expect((await call(`/hx/files/scope?channel=${encodeURIComponent(channel)}`)).status).toBe(404);
 }
 expect((await call('/hx/files/scope?channel=b:general','GET',undefined,null)).status).toBe(401);
 expect((await call('/hx/files/scope?channel=b:general','GET',undefined,guest)).status).toBe(403);
});

test('lost create responses can be recovered without adopting another author or overwriting content',async()=>{
 const command={scope:'workspace',path:'recover.txt',requestId:`file-${crypto.randomUUID()}`};
 const first=await call('/hx/files','POST',command);expect(first.status).toBe(201);const {id}=await first.json();
 const replay=await call('/hx/files','POST',command);expect(replay.status).toBe(200);expect((await replay.json()).id).toBe(id);
 expect((await call('/hx/files','POST',{...command,path:'changed.txt'})).status).toBe(409);
 await upsertUser(env.DB,{githubId:'file-peer',login:'file-peer',name:'peer'});await upsertMembership(env.DB,orgId,'file-peer','member');
 const peer=await createSession(env.DB,'file-peer','test');
 expect((await call('/hx/files','POST',command,peer)).status).toBe(409);
 expect((await call(`/hx/files/${id}/content?expectedVersion=0&size=5`,'PUT','hello',token,true)).status).toBe(200);
 expect((await call('/hx/files','POST',command)).status).toBe(409);
 expect(await (await call(`/hx/files/${id}/versions/1/content`)).text()).toBe('hello');
 expect((await call('/hx/files','POST',{...command,requestId:'invalid'})).status).toBe(400);
});

test('folder listing is hierarchical paginated and excludes inaccessible content',async()=>{
 const ids=[];
 for(const path of ['Alpha/one.txt','Alpha/nested/two.txt','Beta/three.txt','root.txt']){
  const {id}=await (await call('/hx/files','POST',{scope:'workspace',path})).json();ids.push(id);
  expect((await call(`/hx/files/${id}/content?expectedVersion=0&size=1`,'PUT','x',token,true)).status).toBe(200);
 }
 let page=await (await call('/hx/files/folders?scope=workspace&limit=1')).json();expect(page).toEqual({folders:[{name:'Alpha',path:'Alpha/'}],next:'Alpha'});
 page=await (await call('/hx/files/folders?scope=workspace&limit=1&cursor=Alpha')).json();expect(page).toEqual({folders:[{name:'Beta',path:'Beta/'}],next:null});
 expect((await (await call('/hx/files/folders?scope=workspace&directory=Alpha%2F')).json()).folders).toEqual([{name:'nested',path:'Alpha/nested/'}]);
 expect((await (await call('/hx/files/folders?scope=g:private')).json()).folders).toEqual([]);
 await call(`/hx/files/${ids[2]}`,'DELETE',{expectedVersion:1});
 expect((await (await call('/hx/files/folders?scope=workspace')).json()).folders).toHaveLength(1);
 expect((await (await call('/hx/files/folders?scope=workspace&includeDeleted=true')).json()).folders).toHaveLength(2);
 expect((await (await call('/hx/files?scope=workspace&directOnly=true')).json()).files.map(f=>f.path)).toEqual(['root.txt']);
 expect((await (await call('/hx/files?scope=workspace&directOnly=true&directory=Alpha')).json()).files.map(f=>f.path)).toEqual(['Alpha/one.txt']);
 expect((await call('/hx/files?scope=workspace&directOnly=invalid')).status).toBe(400);
 expect((await call('/hx/files/folders?scope=all')).status).toBe(400);
 expect((await call('/hx/files/folders?scope=workspace&directory=..')).status).toBe(400);
});
