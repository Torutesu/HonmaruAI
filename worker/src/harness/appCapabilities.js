import { enqueueExecution, readExecution } from './executions.js';
import { sealField, openField, isSealed } from '../secrets.js';
import { digest } from './appDatabase.js';
const err = (error, status=400) => ({ error, status });
const nameOK = n => typeof n === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(n);
const codeOK = c => typeof c === 'string' && c.trim() && c.length <= 40000;
export async function actions(db, orgId, appId) {
  const { results } = await db.prepare('SELECT name,version,draft,published,published_version AS publishedVersion,updated_at AS updatedAt FROM hx_app_actions WHERE org_id=?1 AND app_id=?2 ORDER BY name').bind(orgId,appId).all();
  return { actions: results || [] };
}
export async function generateAction(prompt, complete) {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length>4000) return err('Describe the action in 1–4000 characters.');
  if (!complete) return err('AI generation is unavailable within the current allowance.',503);
  try {
    const raw=await complete('Return JSON {"name":"lowercase_action_name","code":"JavaScript async function body"}. Only input is available. Return a JSON value. Run calculations, transformations or validation. No network, filesystem, environment variables, process, imports, database access, secrets or external dependencies. Use only JavaScript built-ins. Maximum runtime 60 seconds. Code is reviewed and explicitly published before execution.',prompt);
    const result=JSON.parse(String(raw).replace(/^```(?:json)?|```$/gm,'').trim());
    return nameOK(result.name)&&codeOK(result.code)?result:err('Invalid generated action.',502);
  } catch { return err('The model did not return a valid action.',502); }
}
export async function saveAction(db,orgId,appId,input,by) {
  if (!nameOK(input.name)||!Number.isSafeInteger(input.version)||input.version<0) return err('A name and current action version are required.');
  const old=await db.prepare('SELECT * FROM hx_app_actions WHERE org_id=?1 AND app_id=?2 AND name=?3').bind(orgId,appId,input.name).first();
  if ((old?.version||0)!==input.version) return err('Action changed. Reload before saving.',409);
  let code=old?.draft, published=old?.published??null,publishedVersion=old?.published_version??null;
  if(input.action==='draft') code=input.code;
  else if(input.action==='publish') { published=code; publishedVersion=input.version+1; }
  else if(input.action==='unpublish') {published=null;publishedVersion=null;}
  else if(input.action==='restore') {
    const prior=await db.prepare('SELECT code FROM hx_app_action_versions WHERE org_id=?1 AND app_id=?2 AND name=?3 AND version=?4').bind(orgId,appId,input.name,Number(input.restoreVersion)).first();code=prior?.code;
  } else return err('Unknown action change.');
  if(!codeOK(code)) return err('JavaScript code must contain 1–40000 characters.');
  const at=new Date().toISOString(),version=input.version+1;
  const stmt=old ? db.prepare('UPDATE hx_app_actions SET version=?4,draft=?5,published=?6,published_version=?7,updated_at=?8 WHERE org_id=?1 AND app_id=?2 AND name=?3 AND version=?9').bind(orgId,appId,input.name,version,code,published,publishedVersion,at,input.version)
    : db.prepare('INSERT OR IGNORE INTO hx_app_actions (org_id,app_id,name,version,draft,published,published_version,updated_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE (SELECT COUNT(*) FROM hx_app_actions WHERE org_id=?1 AND app_id=?2)<20').bind(orgId,appId,input.name,version,code,published,publishedVersion,at);
  const results=await db.batch([stmt,db.prepare('INSERT INTO hx_app_action_versions (org_id,app_id,name,version,code,created_by,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE changes()=1').bind(orgId,appId,input.name,version,code,String(by),at)]);
  return results[0].meta?.changes?{saved:true,version}:err('Action changed or the 20-action limit was reached.',409);
}
export async function runAction(db,orgId,appId,input,by) {
  const action=await db.prepare('SELECT published,published_version FROM hx_app_actions WHERE org_id=?1 AND app_id=?2 AND name=?3').bind(orgId,appId,String(input.name||'')).first();
  if(!action?.published) return err('No published action.',404);
  if(input.version!==action.published_version) return err('Published action changed. Review it before running.',409);
  if(typeof input.requestId!=='string'||! /^[\w-]{1,80}$/.test(input.requestId)) return err('A unique request ID is required.');
  // Namespaced idempotency prevents an unrelated gateway request being read through an app.
  const requestId=await digest(JSON.stringify([appId,input.name,input.version,input.requestId]));
  const result=await enqueueExecution(db,orgId,by,{gatewayId:input.gatewayId,code:action.published,input:input.input,requestId},{appId,name:input.name,version:input.version});
  if(result.error)return result;

  return result;
}
export async function readActionJob(db,orgId,appId,by,id) {
  const link=await db.prepare('SELECT job_id FROM hx_app_action_jobs WHERE org_id=?1 AND app_id=?2 AND job_id=?3 AND created_by=?4').bind(orgId,appId,id,String(by)).first();
  return link?readExecution(db,orgId,by,id):err('No such app execution.',404);
}

// Only documented public API origins. No user-hosted URL, DNS rebinding or redirects.
// Each exact URL/method is approved by the connection owner. Code cannot select
// a path, method, query or header. Write bodies are shown for separate host approval.
// Connections are never shared across people.
export const CONNECTION_HOSTS=['api.github.com','api.notion.com','slack.com','www.googleapis.com','sheets.googleapis.com','api.open-meteo.com'];
export function connectionEndpoint(raw, method='GET') {
  try {
    if(!['GET','POST','PATCH','PUT','DELETE'].includes(method))return null;
    const u=new URL(raw);
    if(u.protocol!=='https:'||!CONNECTION_HOSTS.includes(u.hostname)||u.port||u.username||u.password||u.hash||raw.length>2000)return null;
    // OAuth credentials belong in the sealed bearer field, never in a URL/log.
    if([...u.searchParams.keys()].some(k=>/token|secret|key|password|auth/i.test(k)))return null;
    // Slack GET methods can mutate state; admit only read endpoints explicitly.
    if(u.hostname==='slack.com'&&!(method==='GET'?/^\/api\/(?:conversations\.(?:history|replies|info|list)|users\.(?:info|list))$/:/^\/api\/chat\.(?:postMessage|update|delete)$/).test(u.pathname))return null;
    if(method!=='GET') {
      const paths={
        'api.github.com':/^\/repos\/[\w.-]+\/[\w.-]+\/(?:issues|pulls)(?:\/[0-9]+)?(?:\/comments)?(?:\/[0-9]+)?$/,
        'api.notion.com':/^\/v1\/(?:pages|blocks)(?:\/[a-fA-F0-9-]+)?(?:\/children)?$/,
        'slack.com':/^\/api\/chat\.(?:postMessage|update|delete)$/,
        'www.googleapis.com':/^\/(?:drive\/v3\/files(?:\/[\w-]+)?|calendar\/v3\/calendars\/[^/]+\/events(?:\/[^/]+)?)$/,
        'sheets.googleapis.com':/^\/v4\/spreadsheets\/[\w-]+(?:\/values\/[^?]+|:batchUpdate)$/,
      };
      if(!paths[u.hostname]?.test(u.pathname))return null;
    }
    return u.href;
  } catch {return null;}
}
export async function connections(db,orgId,appId,by) {
  const {results}=await db.prepare('SELECT name,version,endpoint,method,enabled,CASE WHEN token IS NOT NULL THEN 1 ELSE 0 END AS hasToken FROM hx_app_connections WHERE org_id=?1 AND app_id=?2 AND created_by=?3 ORDER BY name').bind(orgId,appId,String(by)).all();
  return {connections:results||[],hosts:CONNECTION_HOSTS};
}
export async function saveConnection(db,orgId,appId,by,input) {
  if(!nameOK(input.name)||!Number.isSafeInteger(input.version)||input.version<0)return err('A connection name and version are required.');
  const method=input.method||'GET';
  const endpoint=connectionEndpoint(input.endpoint,method);
  if(!endpoint)return err('Use a supported HTTPS API endpoint and method, without credentials in the URL.');
  if(input.token!==undefined&&(typeof input.token!=='string'||input.token.length>8000||/[\r\n]/.test(input.token)))return err('Invalid bearer token.');
  const old=await db.prepare('SELECT * FROM hx_app_connections WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND name=?4').bind(orgId,appId,String(by),input.name).first();
  if((old?.version||0)!==input.version)return err('Connection changed. Reload before saving.',409);
  // Changing origin clears the old credential instead of sending it to a new service.
  const context=`hx_app_connection:${orgId}:${appId}:${by}:${input.name}`;
  let token=input.token===undefined?(old?.endpoint&&new URL(old.endpoint).origin===new URL(endpoint).origin?old.token:null):input.token?await sealField(input.token,context,orgId):null;
  if(token&&!isSealed(token))return err('Encrypted credential storage is unavailable.',503);
  const enabled=input.enabled===false?0:1,version=input.version+1;
  const stmt=old?db.prepare('UPDATE hx_app_connections SET version=?5,endpoint=?6,token=?7,enabled=?8,method=?10 WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND name=?4 AND version=?9').bind(orgId,appId,String(by),input.name,version,endpoint,token,enabled,input.version,method)
    :db.prepare('INSERT OR IGNORE INTO hx_app_connections (org_id,app_id,created_by,name,version,endpoint,token,enabled,method) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE (SELECT COUNT(*) FROM hx_app_connections WHERE org_id=?1 AND app_id=?2 AND created_by=?3)<20').bind(orgId,appId,String(by),input.name,version,endpoint,token,enabled,method);
  const r=await stmt.run();return r.meta?.changes?{saved:true,version}:err('Connection changed or limit reached.',409);
}
export async function invokeConnection(db,orgId,appId,by,input) {
  const row=await db.prepare('SELECT * FROM hx_app_connections WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND name=?4 AND enabled=1').bind(orgId,appId,String(by),String(input.name||'')).first();
  if(!row)return err('No enabled connection for this account.',404);
  if(input.version!==row.version)return err('Connection changed. Review it before requesting.',409);
  if(!connectionEndpoint(row.endpoint,row.method))return err('Connection is no longer supported.',403);
  const token=row.token?await openField(row.token,`hx_app_connection:${orgId}:${appId}:${by}:${row.name}`):null;
  if(row.token&&!token)return err('The credential cannot be opened.',503);
  let body;
  if(row.method!=='GET') {
    if(!input.body||typeof input.body!=='object'||Array.isArray(input.body))return err('A JSON object body is required.');
    body=JSON.stringify(input.body);
    if(new TextEncoder().encode(body).length>20000)return err('External request body exceeds 20KB.',413);
    if(typeof input.requestId!=='string'||! /^[\w-]{1,80}$/.test(input.requestId))return err('A unique request ID is required for external writes.');
    const saved=await db.prepare("INSERT OR IGNORE INTO hx_app_connection_requests (org_id,app_id,created_by,request_id,connection_name,connection_version,body_hash,status,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'started',?8)").bind(orgId,appId,String(by),input.requestId,row.name,row.version,await digest(body),new Date().toISOString()).run();
    if(!saved.meta?.changes)return err('This external write was already attempted. Check the service before creating another request.',409);
  }
  const finish=async(status,result)=>{
    if(row.method!=='GET')await db.prepare('UPDATE hx_app_connection_requests SET status=?1 WHERE org_id=?2 AND app_id=?3 AND created_by=?4 AND request_id=?5').bind(status,orgId,appId,String(by),input.requestId).run();
    return result;
  };
  try {
    const response=await fetch(row.endpoint,{method:row.method,body,redirect:'manual',signal:AbortSignal.timeout(15000),headers:{...(body?{'content-type':'application/json'}:{}),accept:'application/json','user-agent':'HonmaruAI','notion-version':'2026-03-11',...(token?{authorization:`Bearer ${token}`}:{})}});
    if(!response.ok){await response.body?.cancel();return finish('failed',err(`External API returned ${response.status}.`,502));}
    if(response.status===204)return finish('succeeded',{data:null});
    if(!response.headers.get('content-type')?.includes('json')){await response.body?.cancel();return finish('unknown',err('The connection did not return JSON. Check the service before retrying.',502));}
    const reader=response.body.getReader(),chunks=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>200000){await reader.cancel();return finish('unknown',err('External response exceeds 200KB. Check the service before retrying.',413));}chunks.push(value);}
    const joined=new Uint8Array(size);let offset=0;for(const c of chunks){joined.set(c,offset);offset+=c.byteLength;}
    return finish('succeeded',{data:JSON.parse(new TextDecoder().decode(joined))});
  } catch {return finish('unknown',err('External request failed or timed out. A write may have succeeded; check the service before retrying.',502));}
}
