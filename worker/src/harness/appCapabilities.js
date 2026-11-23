import { enqueueExecution, readExecution } from './executions.js';
import { aad, sealField, openField, isSealed } from '../secrets.js';
import { digest } from './appDatabase.js';
import { getMode } from './mode.js';
import { workspaceBudgetAdmission } from '../workspaceAIBudget.js';
import { allowed } from '../permissions.js';
import { mayUseApp } from './resourceAccess.js';
import { decodeAppOAuth, encodeAppOAuth, parseAppOAuth, refreshGoogleToken } from './appConnectionOAuth.js';
import { isPublicUrl } from '../links.js';
const err = (error, status=400) => ({ error, status });
const nameOK = n => typeof n === 'string' && /^[a-z][a-z0-9_]{0,39}$/.test(n);
const codeOK = c => typeof c === 'string' && c.trim() && c.length <= 40000;
async function openConnectionCredential(orgId,appId,ownerId,name,stored) {
  const oauth=await openField(stored,aad.appConnectionOAuthClient(orgId,appId,ownerId,name));
  if(oauth!==null)return oauth;
  return openField(stored,`hx_app_connection:${orgId}:${appId}:${ownerId}:${name}`);
}
export async function actions(db, orgId, appId) {
  const { results } = await db.prepare(`SELECT name,version,draft,COALESCE(draft_language,'javascript') AS language,published,
    COALESCE(published_language,draft_language,'javascript') AS publishedLanguage,published_version AS publishedVersion,updated_at AS updatedAt
    FROM hx_app_actions WHERE org_id=?1 AND app_id=?2 ORDER BY name`).bind(orgId,appId).all();
  return { actions: results || [] };
}
export async function generateAction(prompt, complete, language='javascript') {
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length>4000) return err('Describe the action in 1–4000 characters.');
  if (!['javascript','typescript'].includes(language)) return err('Choose JavaScript or TypeScript.');
  if (!complete) return err('AI generation is unavailable within the current allowance.',503);
  try {
    const contract=language==='typescript'
      ? 'Return a standalone TypeScript module exporting one default async function: export default async function(input: unknown, env: Readonly<Record<string,string>>): Promise<unknown> { ... }. Return JSON {"name":"lowercase_action_name","language":"typescript","code":"..."}. Use type annotations only; do not import modules or declare dependencies. The function receives JSON input and a read-only env object containing this app\'s configured secrets. Use env.KEY only when the app owner configured that key; never return, log, or include a secret in an error. It must return a JSON value. No network, filesystem, process, database access or external dependencies. Maximum runtime 60 seconds. Code is reviewed and explicitly published before execution.'
      : 'Return JSON {"name":"lowercase_action_name","language":"javascript","code":"JavaScript async function body"}. The code MUST be a function BODY, for example: return input.a + input.b; The body receives input and a read-only env object containing this app\'s configured secrets. Use env.KEY only when the app owner configured that key; never return, log, or include a secret in an error. Do not declare an outer function or export. Return a JSON value. Run calculations, transformations or validation. No network, filesystem, process, imports, database access or external dependencies. Use only JavaScript built-ins. Maximum runtime 60 seconds. Code is reviewed and explicitly published before execution.';
    const raw=await complete(contract,prompt);
    const result=JSON.parse(String(raw).replace(/^```(?:json)?|```$/gm,'').trim());
    result.language=result.language??language;
    if (!nameOK(result.name)||!codeOK(result.code)||result.language!==language) return err('Invalid generated action.',502);
    // Some models return a complete function despite the body-only contract.
    // Invoke that function inside the existing sandbox; never evaluate it here.
    const source=result.code.trim();
    if (language==='typescript'&&!/^export\s+default\s+(?:async\s+)?function\b/.test(source)) return err('TypeScript actions must export a default function.',502);
    if (language==='javascript'&&/^(?:async\s+)?function\s+[A-Za-z_$][\w$]*\s*\(\s*input\s*\)\s*\{[\s\S]*\}\s*;?$/.test(source)) {
      result.code=`return await (${source.replace(/;$/, '')})(input);`;
    }
    return result;
  } catch { return err('The model did not return a valid action.',502); }
}
export async function saveAction(db,orgId,appId,input,by) {
  if (!nameOK(input.name)||!Number.isSafeInteger(input.version)||input.version<0) return err('A name and current action version are required.');
  if(input.language!==undefined&&!['javascript','typescript'].includes(input.language))return err('Choose JavaScript or TypeScript.');
  const old=await db.prepare('SELECT * FROM hx_app_actions WHERE org_id=?1 AND app_id=?2 AND name=?3').bind(orgId,appId,input.name).first();
  if ((old?.version||0)!==input.version) return err('Action changed. Reload before saving.',409);
  let code=old?.draft, language=old?.draft_language||'javascript', published=old?.published??null,publishedLanguage=old?.published_language||old?.draft_language||'javascript',publishedVersion=old?.published_version??null;
  if(input.action==='draft') {code=input.code;language=input.language||language;}
  else if(input.action==='publish') { published=code;publishedLanguage=language; publishedVersion=input.version+1; }
  else if(input.action==='unpublish') {published=null;publishedLanguage=null;publishedVersion=null;}
  else if(input.action==='restore') {
    const prior=await db.prepare("SELECT code,COALESCE(language,'javascript') AS language FROM hx_app_action_versions WHERE org_id=?1 AND app_id=?2 AND name=?3 AND version=?4").bind(orgId,appId,input.name,Number(input.restoreVersion)).first();code=prior?.code;language=prior?.language||'javascript';
  } else return err('Unknown action change.');
  if(!['javascript','typescript'].includes(language))return err('Choose JavaScript or TypeScript.');
  if(!codeOK(code)) return err('Server action code must contain 1–40000 characters.');
  const at=new Date().toISOString(),version=input.version+1;
  const stmt=old ? db.prepare('UPDATE hx_app_actions SET version=?4,draft=?5,draft_language=?6,published=?7,published_language=?8,published_version=?9,updated_at=?10 WHERE org_id=?1 AND app_id=?2 AND name=?3 AND version=?11').bind(orgId,appId,input.name,version,code,language,published,publishedLanguage,publishedVersion,at,input.version)
    : db.prepare('INSERT OR IGNORE INTO hx_app_actions (org_id,app_id,name,version,draft,draft_language,published,published_language,published_version,updated_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9,?10 WHERE (SELECT COUNT(*) FROM hx_app_actions WHERE org_id=?1 AND app_id=?2)<20').bind(orgId,appId,input.name,version,code,language,published,publishedLanguage,publishedVersion,at);
  const results=await db.batch([stmt,db.prepare("INSERT INTO hx_app_action_versions (org_id,app_id,name,version,code,language,created_by,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE changes()=1").bind(orgId,appId,input.name,version,code,language,String(by),at)]);
  return results[0].meta?.changes?{saved:true,version}:err('Action changed or the 20-action limit was reached.',409);
}
export async function runAction(db,orgId,appId,input,by) {
  const action=await db.prepare("SELECT published,published_version,COALESCE(published_language,draft_language,'javascript') AS language FROM hx_app_actions WHERE org_id=?1 AND app_id=?2 AND name=?3").bind(orgId,appId,String(input.name||'')).first();
  if(!action?.published) return err('No published action.',404);
  if(input.version!==action.published_version) return err('Published action changed. Review it before running.',409);
  if(typeof input.requestId!=='string'||! /^[\w-]{1,80}$/.test(input.requestId)) return err('A unique request ID is required.');
  // Namespaced idempotency prevents an unrelated gateway request being read through an app.
  const requestId=await digest(JSON.stringify([appId,input.name,input.version,input.requestId]));
  const result=await enqueueExecution(db,orgId,by,{gatewayId:input.gatewayId,code:action.published,language:action.language,input:input.input,requestId},{appId,name:input.name,version:input.version});
  if(result.error)return result;

  return result;
}
export async function readActionJob(db,orgId,appId,by,id) {
  const link=await db.prepare('SELECT job_id FROM hx_app_action_jobs WHERE org_id=?1 AND app_id=?2 AND job_id=?3 AND created_by=?4').bind(orgId,appId,id,String(by)).first();
  return link?readExecution(db,orgId,by,id):err('No such app execution.',404);
}

function decodeActionRunCursor(cursor) {
  if (cursor == null || cursor === '') return null;
  if (typeof cursor !== 'string' || cursor.length > 512) return undefined;
  try {
    const parsed = JSON.parse(atob(cursor));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) ||
        Object.keys(parsed).sort().join(',') !== 'createdAt,id' ||
        !Number.isSafeInteger(parsed.createdAt) || parsed.createdAt < 0 ||
        typeof parsed.id !== 'string' || !/^[\w-]{1,200}$/.test(parsed.id)) return undefined;
    return parsed;
  } catch { return undefined; }
}

export async function listAppActionRuns(db,orgId,appId,by,{limit=50,cursor}={}) {
  if (!await allowed(db,orgId,by,'harness.build')) return err('You cannot build in this workspace.',403);
  if (!await mayUseApp(db,orgId,appId,by)) return err('No such app.',404);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) return err('Choose between 1 and 50 execution history entries.');
  const decoded=decodeActionRunCursor(cursor);
  if(decoded===undefined)return err('This execution history cursor is invalid. Reload the history.');
  const bindings=[orgId,appId,String(by)];
  const after=decoded?` AND (g.created_at<?4 OR (g.created_at=?4 AND g.id<?5))`:'';
  if(decoded)bindings.push(decoded.createdAt,decoded.id);
  bindings.push(limit+1);
  const {results=[]}=await db.prepare(`SELECT g.id,j.action_name AS actionName,j.action_version AS actionVersion,
      g.status,g.created_at AS createdAt,g.started_at AS startedAt,g.finished_at AS finishedAt
    FROM hx_app_action_jobs j JOIN hx_gateway_jobs g ON g.org_id=j.org_id AND g.id=j.job_id AND g.created_by=j.created_by
    WHERE j.org_id=?1 AND j.app_id=?2 AND j.created_by=?3${after}
    ORDER BY g.created_at DESC,g.id DESC LIMIT ?${bindings.length}`)
    .bind(...bindings).all();
  const hasMore=results.length>limit;
  const runs=results.slice(0,limit);
  const last=runs.at(-1);
  return {runs,...(hasMore&&last?{nextCursor:btoa(JSON.stringify({createdAt:last.createdAt,id:last.id}) )}:{})};
}

// Built-in providers have narrow path rules. Custom APIs are limited to one
// owner-registered public HTTPS URL and method; callers cannot choose a host,
// path, method or header. Cloudflare's Worker egress proxy blocks private and
// local destinations, while this layer rejects private literals and names.
// Redirects stay disabled so credentials never cross the registered origin.
export const CONNECTION_HOSTS=['api.github.com','api.notion.com','slack.com','www.googleapis.com','sheets.googleapis.com','api.open-meteo.com'];
export function connectionEndpoint(raw, method='GET') {
  try {
    if(!['GET','POST','PATCH','PUT','DELETE'].includes(method))return null;
    const u=new URL(raw);
    const builtin=CONNECTION_HOSTS.includes(u.hostname);
    const blockedSuffix=['.test','.example','.invalid','.example.com','.example.net','.example.org'];
    if(u.protocol!=='https:'||u.port||u.username||u.password||u.hash||raw.length>2000||
      (!builtin&&(!isPublicUrl(u.href)||blockedSuffix.some(s=>u.hostname===s.slice(1)||u.hostname.endsWith(s)))))return null;
    // OAuth credentials belong in the sealed bearer field, never in a URL/log.
    if([...u.searchParams.keys()].some(k=>/token|secret|key|password|auth/i.test(k)))return null;
    // Built-in services keep narrow method/path rules. A custom service is
    // owner-configured as one exact endpoint/method and writes are approved
    // separately for every request.
    if(builtin&&u.hostname==='slack.com'&&!(method==='GET'?/^\/api\/(?:conversations\.(?:history|replies|info|list)|users\.(?:info|list))$/:/^\/api\/chat\.(?:postMessage|update|delete)$/).test(u.pathname))return null;
    if(builtin&&method!=='GET') {
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
  const {results=[]}=await db.prepare('SELECT name,version,endpoint,method,enabled,token FROM hx_app_connections WHERE org_id=?1 AND app_id=?2 AND created_by=?3 ORDER BY name').bind(orgId,appId,String(by)).all();
  const safe=[];
  for(const row of results){
    const raw=row.token?await openConnectionCredential(orgId,appId,by,row.name,row.token):null;
    const c=parseAppOAuth(raw);
    if(c){
      safe.push({name:row.name,version:row.version,endpoint:row.endpoint,method:row.method,enabled:row.enabled,hasToken:Number(Boolean(c)),authMode:'oauth',oauthProvider:'google',oauthClientId:c?.clientId||'',oauthScope:c?.scope||'',oauthConfigured:Boolean(c?.clientId&&c?.clientSecret),oauthConnected:Boolean(c?.accessToken&&!c?.requiresReauthorization),oauthRequiresReauthorization:Boolean(c?.requiresReauthorization)});
    } else safe.push({name:row.name,version:row.version,endpoint:row.endpoint,method:row.method,enabled:row.enabled,hasToken:Number(row.token!==null),authMode:'bearer'});
  }
  return {connections:safe,hosts:CONNECTION_HOSTS};
}
export async function saveConnection(db,orgId,appId,by,input,env=null) {
  if(!nameOK(input.name)||!Number.isSafeInteger(input.version)||input.version<0)return err('A connection name and version are required.');
  const method=input.method||'GET';
  const endpoint=connectionEndpoint(input.endpoint,method);
  if(!endpoint)return err('Use a supported HTTPS API endpoint and method, without credentials in the URL.');
  if(input.token!==undefined&&(typeof input.token!=='string'||input.token.length>8000||/[\r\n]/.test(input.token)))return err('Invalid bearer token.');
  if(input.authMode!==undefined&&!['bearer','oauth'].includes(input.authMode))return err('Choose a supported authentication mode.');
  const old=await db.prepare('SELECT * FROM hx_app_connections WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND name=?4').bind(orgId,appId,String(by),input.name).first();
  if((old?.version||0)!==input.version)return err('Connection changed. Reload before saving.',409);
  // Changing origin clears the old credential instead of sending it to a new service.
  const context=`hx_app_connection:${orgId}:${appId}:${by}:${input.name}`;
  let token;
  if(input.authMode==='oauth'){
    const clientId=String(input.clientId||'').trim();let clientSecret=String(input.clientSecret||'');
    const scope=String(input.scope||'openid email profile').trim();
    if(!clientSecret&&old){const previous=await decodeAppOAuth(orgId,appId,by,input.name,old.token);clientSecret=previous?.clientSecret||'';}
    if(!/^https:\/\/(?:www|sheets)\.googleapis\.com\//.test(endpoint)||!/^\d+-[\w-]+\.apps\.googleusercontent\.com$/.test(clientId)||clientSecret.length>2000||!clientSecret||scope.length>2000||/[\r\n]/.test(scope))return err('Configure a Google OAuth web client and supported Google API endpoint.');
    if(!env)return err('OAuth configuration is unavailable.',503);
    token=await encodeAppOAuth(env,orgId,appId,by,input.name,{clientId,clientSecret,scope,accessToken:'',refreshToken:'',expiresAt:0,requiresReauthorization:false});
    if(!token)return err('Workspace encryption is required for OAuth credentials.',503);
  } else token=input.token===undefined?(old?.endpoint&&new URL(old.endpoint).origin===new URL(endpoint).origin?old.token:null):input.token?await sealField(input.token,context,orgId):null;
  if(token&&!isSealed(token))return err('Encrypted credential storage is unavailable.',503);
  const enabled=input.enabled===false?0:1,version=input.version+1;
  const stmt=old?db.prepare('UPDATE hx_app_connections SET version=?5,endpoint=?6,token=?7,enabled=?8,method=?10 WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND name=?4 AND version=?9').bind(orgId,appId,String(by),input.name,version,endpoint,token,enabled,input.version,method)
    :db.prepare(`INSERT OR IGNORE INTO hx_app_connections (org_id,app_id,created_by,name,version,endpoint,token,enabled,method)
      SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9
      WHERE (SELECT COUNT(*) FROM hx_app_connections WHERE org_id=?1 AND app_id=?2 AND created_by=?3)<20
        AND NOT EXISTS(SELECT 1 FROM hx_app_connections WHERE org_id=?1 AND app_id=?2 AND name=?4)`)
      .bind(orgId,appId,String(by),input.name,version,endpoint,token,enabled,method);
  const updateGrantVersion=old?db.prepare(`UPDATE hx_app_connection_grants SET connection_version=?5
    WHERE org_id=?1 AND app_id=?2 AND connection_owner_id=?3 AND connection_name=?4
      AND connection_version=?8 AND endpoint=?6 AND method=?7
      AND EXISTS(SELECT 1 FROM hx_app_connections c WHERE c.org_id=?1 AND c.app_id=?2
        AND c.created_by=?3 AND c.name=?4 AND c.version=?5 AND c.endpoint=?6 AND c.method=?7 AND c.enabled=1)`)
    .bind(orgId,appId,String(by),input.name,version,endpoint,method,input.version):null;
  const deleteOldGrant=old?db.prepare(`DELETE FROM hx_app_connection_grants WHERE org_id=?1 AND app_id=?2
    AND connection_owner_id=?3 AND connection_name=?4 AND (endpoint!=?5 OR method!=?6 OR ?8=0)
    AND EXISTS(SELECT 1 FROM hx_app_connections c WHERE c.org_id=?1 AND c.app_id=?2
      AND c.created_by=?3 AND c.name=?4 AND c.version=?7 AND c.endpoint=?5 AND c.method=?6 AND c.enabled=?8)`)
    .bind(orgId,appId,String(by),input.name,endpoint,method,version,enabled):null;
  // D1 executes this batch atomically. A matching endpoint/method keeps a grant
  // through credential rotation; changing its scope or disabling it revokes it.
  const results=await db.batch([stmt,...(updateGrantVersion?[updateGrantVersion,deleteOldGrant]:[])]);
  const r=results[0];
  return r.meta?.changes?{saved:true,version}:err('Connection changed or limit reached.',409);
}
export async function invokeConnection(db,orgId,appId,by,input,{env=null,authorize=async()=>true}={}) {
  const row=await db.prepare('SELECT * FROM hx_app_connections WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND name=?4 AND enabled=1').bind(orgId,appId,String(by),String(input.name||'')).first();
  if(!row)return err('No enabled connection for this account.',404);
  if(input.version!==row.version)return err('Connection changed. Review it before requesting.',409);
  if(!connectionEndpoint(row.endpoint,row.method))return err('Connection is no longer supported.',403);
  let endpoint=row.endpoint;
  if(input.query!==undefined){
    if(row.method!=='GET'||!input.query||typeof input.query!=='object'||Array.isArray(input.query)||Object.keys(input.query).length>100)return err('Only GET connections accept bounded query parameters.');
    try{
      const url=new URL(endpoint);
      for(const [key,raw] of Object.entries(input.query)){
        if(!key||key.length>100||/(token|auth|secret|password|credential|api[-_]?key)/i.test(key))return err('Connection query contains a reserved credential field.');
        const values=Array.isArray(raw)?raw:[raw];
        if(values.length>100||values.some(value=>!(typeof value==='string'||typeof value==='boolean'||typeof value==='number'&&Number.isFinite(value))))return err('Connection query values must be bounded scalar values.');
        for(const value of values)url.searchParams.append(key,String(value));
      }
      if(url.href.length>8000)return err('Connection URL exceeds the request limit.');
      endpoint=url.href;
    }catch{return err('Invalid connection query.');}
  }
  let token=null;
  const openedCredential=row.token?await openConnectionCredential(orgId,appId,by,row.name,row.token):null;
  const oauthCredential=parseAppOAuth(openedCredential);
  if(oauthCredential){
    let credential=oauthCredential;
    if(!credential)return err('The credential cannot be opened.',503);
    if(!await authorize())return err('Connection access changed.',403);
    credential=await refreshGoogleToken(env,orgId,appId,by,row.name,row,credential,authorize);
    if(!credential)return err('Reconnect this Google account before using the connection.',409);
    token=credential.accessToken;
  }else token=openedCredential;
  if(row.token&&!token)return err('The credential cannot be opened.',503);
  let body;
  if(row.method!=='GET') {
    if(!input.body||typeof input.body!=='object'||Array.isArray(input.body))return err('A JSON object body is required.');
    body=JSON.stringify(input.body);
    if(new TextEncoder().encode(body).length>20000)return err('External request body exceeds 20KB.',413);
    if(typeof input.requestId!=='string'||! /^[\w-]{1,80}$/.test(input.requestId))return err('A unique request ID is required for external writes.');
  }
  if (await getMode(db, orgId) === 'harness') {
    const budget = await workspaceBudgetAdmission(db, orgId);
    if (!budget.allowed) return err(budget.message, budget.status);
  }
  if(row.method!=='GET') {
    const saved=await db.prepare("INSERT OR IGNORE INTO hx_app_connection_requests (org_id,app_id,created_by,request_id,connection_name,connection_version,body_hash,status,created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,'started',?8)").bind(orgId,appId,String(by),input.requestId,row.name,row.version,await digest(body),new Date().toISOString()).run();
    if(!saved.meta?.changes)return err('This external write was already attempted. Check the service before creating another request.',409);
  }
  const finish=async(status,result)=>{
    if(row.method!=='GET')await db.prepare('UPDATE hx_app_connection_requests SET status=?1 WHERE org_id=?2 AND app_id=?3 AND created_by=?4 AND request_id=?5').bind(status,orgId,appId,String(by),input.requestId).run();
    return result;
  };
  try {
    if(!await authorize())return finish('failed',err('Connection access changed.',403));
    const response=await fetch(endpoint,{method:row.method,body,redirect:'manual',signal:AbortSignal.timeout(15000),headers:{...(body?{'content-type':'application/json'}:{}),accept:'application/json','user-agent':'HonmaruAI','notion-version':'2026-03-11',...(token?{authorization:`Bearer ${token}`}:{})}});
    // The provider may finish after the App, visitor, owner, or grant loses
    // authority. Discard every response before status or body can escape.
    if(!await authorize()) {
      await response.body?.cancel().catch(()=>{});
      return finish('unknown',err('Connection access changed while the request was running; the result was discarded. If this was a write, check the external service before retrying.',403));
    }
    if(!response.ok){await response.body?.cancel();return finish('failed',err(`External API returned ${response.status}.`,502));}
    if(response.status===204)return finish('succeeded',{data:null});
    if(!response.headers.get('content-type')?.includes('json')){await response.body?.cancel();return finish('unknown',err('The connection did not return JSON. Check the service before retrying.',502));}
    const reader=response.body.getReader(),chunks=[];let size=0;
    while(true){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>200000){await reader.cancel();return finish('unknown',err('External response exceeds 200KB. Check the service before retrying.',413));}chunks.push(value);}
    const joined=new Uint8Array(size);let offset=0;for(const c of chunks){joined.set(c,offset);offset+=c.byteLength;}
    return finish('succeeded',{data:JSON.parse(new TextDecoder().decode(joined))});
  } catch {return finish('unknown',err('External request failed or timed out. A write may have succeeded; check the service before retrying.',502));}
}
