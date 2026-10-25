import {env} from 'cloudflare:test';
import {beforeEach,test,expect} from 'vitest';
import worker from '../src/index.js';
import {conversationFile,workspaceFileConversation} from '../src/harness/fileConversation.js';
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

test('recent files page by timestamp and ID without skipping equal-time rows',async()=>{
 const ids=[];
 for(const path of ['z-old.txt','a-new.txt','b-new.txt']){
  const {id}=await (await call('/hx/files','POST',{scope:'workspace',path})).json();ids.push(id);
  await call(`/hx/files/${id}/content?expectedVersion=0&size=1`,'PUT','x',token,true);
 }
 await env.DB.prepare('UPDATE hx_workspace_files SET updated_at=? WHERE org_id=?').bind('2026-10-24T10:00:00.000Z',orgId).run();
 await env.DB.prepare('UPDATE hx_workspace_files SET updated_at=? WHERE org_id=? AND id=?').bind('2026-10-23T10:00:00.000Z',orgId,ids[0]).run();
 const actual=[];let cursor=null;
 do{
  const response=await call('/hx/files?scope=workspace&order=recent&limit=1'+(cursor?'&cursor='+encodeURIComponent(JSON.stringify(cursor)):''));expect(response.status).toBe(200);
  const page=await response.json();actual.push(...page.files.map(file=>file.id));cursor=page.next;
 }while(cursor);
 expect(actual).toEqual([...ids.slice(1).sort().reverse(),ids[0]]);
 const invalid=encodeURIComponent(JSON.stringify({path:'a-new.txt',id:ids[1]}));
 expect((await call('/hx/files?scope=workspace&order=recent&cursor='+invalid)).status).toBe(400);
 expect((await call('/hx/files?scope=workspace&order=invalid')).status).toBe(400);
});

test('HTTP upload origin comes from the authenticated endpoint and migration is required',async()=>{
 const {id}=await (await call('/hx/files','POST',{scope:'workspace',path:'uploads/note.txt',origin:'agent',principalType:'agent'})).json();
 await call(`/hx/files/${id}/content?expectedVersion=0&size=5`,'PUT','hello',token,true);
 expect((await (await call('/hx/files?scope=workspace&origin=human')).json()).files).toEqual([expect.objectContaining({id,origin:'human'})]);
 expect((await (await call('/hx/files?scope=workspace&origin=agent')).json()).files).toEqual([]);
 expect((await (await call('/hx/files/folders?scope=workspace&origin=agent')).json()).folders).toEqual([]);
 expect((await call('/hx/files?scope=workspace&origin=invalid')).status).toBe(400);
 await env.DB.prepare('DROP TABLE hx_workspace_file_origins').run();
 expect((await call('/hx/files?scope=workspace')).status).toBe(503);
});

test('single file metadata is exact, live-authorized and excludes unavailable versions',async()=>{
 const {id}=await (await call('/hx/files','POST',{scope:'workspace',path:'linked.txt'})).json();
 expect((await call(`/hx/files/${id}`)).status).toBe(404); // uncommitted reservation
 await call(`/hx/files/${id}/content?expectedVersion=0&size=5`,'PUT','hello',token,true);
 const response=await call(`/hx/files/${id}`);
 expect(response.status).toBe(200);expect(response.headers.get('cache-control')).toContain('no-store');
 const body=await response.json();expect(body.file).toMatchObject({id,path:'linked.txt',scope:'workspace',origin:'human',version:1,size:5});
 expect(JSON.stringify(body)).not.toMatch(/object_key|content_hash|hello/);
 expect((await call('/hx/files/missing')).status).toBe(404);
 expect((await call(`/hx/files/${id}`,'GET',undefined,guest)).status).toBe(403);
 await env.DB.prepare('UPDATE hx_workspace_files SET scope=? WHERE org_id=? AND id=?').bind('g:closed',orgId,id).run();
 expect((await call(`/hx/files/${id}`)).status).toBe(404);
 await env.DB.prepare('UPDATE hx_workspace_files SET scope=? WHERE org_id=? AND id=?').bind('workspace',orgId,id).run();
 await call(`/hx/files/${id}`,'DELETE',{expectedVersion:1});
 expect((await call(`/hx/files/${id}`)).status).toBe(404);
});

test('versioned files share one authorized conversation across simultaneous opens',async()=>{
 const scope='g:abcdef0123456789';
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES(?,?,?,'now')").bind(orgId,scope,'file-human').run();
 const {id}=await (await call('/hx/files','POST',{scope,path:'discussion.txt',requestId:`file-${crypto.randomUUID()}`})).json();
 const endpoint='/channels/files/conversation';
 expect((await call(`${endpoint}?fileId=${id}`)).status).toBe(404);
 await call(`/hx/files/${id}/content?expectedVersion=0&size=5`,'PUT','hello',token,true);
 const read=await call(`${endpoint}?fileId=${id}`);expect(read.status).toBe(200);expect((await read.json()).threadId).toBeNull();
 const responses=await Promise.all([call(endpoint,'POST',{orgId,fileId:id}),call(endpoint,'POST',{orgId,fileId:id})]);
 for(const response of responses)expect(response.status).toBe(200);
 const results=await Promise.all(responses.map(r=>r.json()));expect(results[0].threadId).toBe(results[1].threadId);
 const threadId=results[0].threadId;expect(threadId).toBe(`workspace-file-thread-${id}`);
 expect((await env.DB.prepare('SELECT count(*) AS n FROM channel_messages WHERE org_id=? AND id=?').bind(orgId,threadId).first()).n).toBe(1);
 await call(`/hx/files/${id}/content?expectedVersion=1&size=3`,'PUT','new',token,true);
 expect((await (await call(`${endpoint}?fileId=${id}`)).json()).threadId).toBe(threadId);
 await env.DB.prepare('DELETE FROM conversation_members WHERE org_id=? AND channel=? AND login=?').bind(orgId,scope,'file-human').run();
 expect((await call(endpoint,'POST',{orgId,fileId:id})).status).toBe(404);
 expect((await call(`${endpoint}?fileId=${id}`)).status).toBe(404);
});

 test.each(['membership','deleted'])('stale file snapshot cannot create a conversation after %s changes',async(change)=>{
 const scope='g:abcdef0123456789';
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES(?,?,?,'now')").bind(orgId,scope,'file-human').run();
 const {id}=await (await call('/hx/files','POST',{scope,path:'race.txt',requestId:`file-${crypto.randomUUID()}`})).json();
 expect((await call(`/hx/files/${id}/content?expectedVersion=0&size=5`,'PUT','hello',token,true)).status).toBe(200);
 const file=await conversationFile(env.DB,{orgId,userId:'file-human',fileId:id});expect(file).toBeTruthy();
 if(change==='membership')await env.DB.prepare('DELETE FROM conversation_members WHERE org_id=? AND channel=? AND login=?').bind(orgId,scope,'file-human').run();
 else expect((await call(`/hx/files/${id}`,'DELETE',{expectedVersion:1})).status).toBe(200);
 for(const create of [false,true])expect((await workspaceFileConversation(env.DB,{orgId,userId:'file-human',file,create})).status).toBe(404);
 expect((await env.DB.prepare('SELECT count(*) AS n FROM channel_messages WHERE org_id=? AND id=?').bind(orgId,`workspace-file-thread-${id}`).first()).n).toBe(0);
 });

test('AI file replies pin the version and recheck live authority',async()=>{
 const {fileThreadTools}=await import('../src/harness/fileThreadTools.js');
 const {setMode}=await import('../src/harness/mode.js');
 const scope='g:abcdef0123456789';
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES(?,?,?,'now')").bind(orgId,scope,'file-human').run();
 const {id}=await (await call('/hx/files','POST',{scope,path:'context.txt'})).json();
 expect((await call(`/hx/files/${id}/content?expectedVersion=0&size=5`,'PUT','hello',token,true)).status).toBe(200);
 const {threadId}=await (await call('/channels/files/conversation','POST',{orgId,fileId:id})).json();
 const taint={value:false};const context={orgId,session:{github_id:'file-human'},fileScope:scope,fileThreadId:threadId,taint};
 expect(await fileThreadTools(env,context)).toEqual({});
 await setMode(env.DB,orgId,'harness','file-human');
 expect(await fileThreadTools(env,{...context,fileScope:'g:other'})).toEqual({});
 expect(await fileThreadTools(env,{...context,fileThreadId:'unrelated'})).toEqual({});
 const tools=await fileThreadTools(env,context);expect(Object.keys(tools)).toEqual(['read_thread_file']);
 expect((await call(`/hx/files/${id}/content?expectedVersion=1&size=3`,'PUT','new',token,true)).status).toBe(200);
 expect(JSON.parse(await tools.read_thread_file.run({fileId:'other',version:2}))).toMatchObject({fileId:id,version:1,text:'hello',untrustedContent:true});
 expect(taint.value).toBe(true);
 const {agentTools}=await import('../src/agentTools.js');
 const integrated=await agentTools(env,{...context,personal:false});
 expect(Object.keys(integrated).sort()).toEqual(['read_thread_file','read_url']);
 expect(JSON.parse(await integrated.read_thread_file.run())).toMatchObject({version:2,text:'new'});
 expect(await integrated.read_url.run({url:'https://example.com'})).toContain('Not opened');
 const fresh=await fileThreadTools(env,context);
 expect(JSON.parse(await fresh.read_thread_file.run())).toMatchObject({version:2,text:'new'});
 await env.DB.prepare('DELETE FROM conversation_members WHERE org_id=? AND channel=? AND login=?').bind(orgId,scope,'file-human').run();
 expect(JSON.parse(await tools.read_thread_file.run())).toHaveProperty('error');
 expect(await fileThreadTools(env,context)).toEqual({});
});

test('file AI pages preserve Unicode and reject a root deleted during storage read',async()=>{
 const {fileThreadTools}=await import('../src/harness/fileThreadTools.js');
 const {setMode}=await import('../src/harness/mode.js');
 const scope='g:abcdef0123456789';
 await env.DB.prepare("INSERT INTO conversation_members(org_id,channel,login,added_at) VALUES(?,?,?,'now')").bind(orgId,scope,'file-human').run();
 const {id}=await (await call('/hx/files','POST',{scope,path:'long.txt'})).json();
 const text='あ😀\n'.repeat(8000),size=new TextEncoder().encode(text).length;
 expect((await call(`/hx/files/${id}/content?expectedVersion=0&size=${size}`,'PUT',text,token,true)).status).toBe(200);
 const {threadId}=await (await call('/channels/files/conversation','POST',{orgId,fileId:id})).json();
 await setMode(env.DB,orgId,'harness','file-human');
 const context={orgId,session:{github_id:'file-human'},fileScope:scope,fileThreadId:threadId,taint:{value:false}};
 const {read_thread_file:tool}=await fileThreadTools(env,context);
 let offset=0,parts=[];
 do{
  const raw=await tool.run({offset});expect(raw.length).toBeLessThan(20000);
  const page=JSON.parse(raw);expect(page.version).toBe(1);expect(page.totalCharacters).toBe(24000);
  expect(Array.from(page.text).length).toBeLessThanOrEqual(16000);parts.push(page.text);offset=page.nextOffset;
 }while(offset!==null);
 expect(parts.length).toBeGreaterThan(1);expect(parts.join('')).toBe(text);
 for(const offset of [-1,0.5,24001])expect(JSON.parse(await tool.run({offset}))).toHaveProperty('error');
 const changing={...env,MEDIA:{get:async key=>{
  const object=await env.MEDIA.get(key);
  await env.DB.prepare('UPDATE channel_messages SET deleted_at=? WHERE org_id=? AND id=?').bind(new Date().toISOString(),orgId,threadId).run();
  return object;
 }}};
 const stale=await fileThreadTools(changing,context);
 const result=JSON.parse(await stale.read_thread_file.run({offset:0}));expect(result).toHaveProperty('error');expect(result).not.toHaveProperty('text');
});
