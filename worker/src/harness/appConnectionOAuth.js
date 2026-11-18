import { aad, openField, sealField } from '../secrets.js';
import { allowed } from '../permissions.js';
import { hasExplicitAppPermission, mayEditApp, mayUseApp } from './resourceAccess.js';

const TAG = '__honmaru_app_oauth_v1';
const AUTH = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN = 'https://oauth2.googleapis.com/token';
const enc = new TextEncoder();
const rand = (n=32) => btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(n)))).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const sha = async value => btoa(String.fromCharCode(...new Uint8Array(await crypto.subtle.digest('SHA-256',enc.encode(value)))))
  .replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
const safe = (s,n) => typeof s==='string'&&s.trim().length>0&&s.length<=n&&!/[\u0000-\u001f\u007f]/.test(s);

export function isAppOAuth(value) { try { return JSON.parse(value)?.[TAG]===1; } catch { return false; } }
export function parseAppOAuth(value) { try { const v=JSON.parse(value);return v?.[TAG]===1?v:null; } catch { return null; } }
export async function encodeAppOAuth(env,orgId,appId,ownerId,name,value) {
  if(!env.DATA_KEY) return null;
  const sealed=await sealField(JSON.stringify({[TAG]:1,...value}),aad.appConnectionOAuthClient(orgId,appId,ownerId,name),orgId);
  return sealed;
}
export async function decodeAppOAuth(orgId,appId,ownerId,name,stored) {
  const raw=await openField(stored,aad.appConnectionOAuthClient(orgId,appId,ownerId,name));
  return parseAppOAuth(raw);
}

export async function startAppConnectionOAuth(env,orgId,appId,ownerId,name,origin) {
  if(!env.DATA_KEY)return {error:'Workspace encryption is required for OAuth connections.',status:503};
  const row=await env.DB.prepare(`SELECT * FROM hx_app_connections WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND name=?4 AND enabled=1`)
    .bind(orgId,appId,String(ownerId),name).first();
  if(!row)return {error:'Configure an OAuth connection first.',status:404};
  const config=await decodeAppOAuth(orgId,appId,ownerId,name,row.token);
  if(!config?.clientId||!config?.clientSecret)return {error:'OAuth configuration cannot be opened.',status:503};
  let trustedOrigin;
  try { const configured=new URL(String(env.APP_WEB_URL||''));if(configured.protocol!=='https:'||configured.username||configured.password)return {error:'OAuth requires a configured HTTPS app URL.',status:503};trustedOrigin=configured.origin; }
  catch { return {error:'OAuth requires a configured HTTPS app URL.',status:503}; }
  const redirectUri=`${trustedOrigin}/apps/oauth/callback`;
  const state=rand(),stateHash=await sha(state),verifier=rand(48);
  const challenge=await sha(verifier),now=new Date(),expires=new Date(now.getTime()+600000).toISOString();
  const sealed=await sealField(verifier,aad.appConnectionOAuthVerifier(orgId,stateHash),orgId);
  await env.DB.prepare('DELETE FROM hx_app_connection_oauth_states WHERE org_id=?1 AND expires_at<=?2').bind(orgId,now.toISOString()).run();
  await env.DB.prepare(`INSERT INTO hx_app_connection_oauth_states
    (state_hash,org_id,app_id,owner_id,connection_name,connection_version,endpoint,method,credential_ciphertext,client_id,client_secret,scope,redirect_uri,code_verifier,created_at,expires_at)
    VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16)`)
    .bind(stateHash,orgId,appId,String(ownerId),name,row.version,row.endpoint,row.method,row.token,config.clientId,
      await sealField(config.clientSecret,`hx_app_connection_oauth_states.client_secret:${orgId}:${stateHash}`,orgId),config.scope||'',redirectUri,sealed,now.toISOString(),expires).run();
  const params=new URLSearchParams({client_id:config.clientId,redirect_uri:redirectUri,response_type:'code',access_type:'offline',prompt:'consent',state,
    code_challenge:challenge,code_challenge_method:'S256',scope:config.scope||'openid email profile'});
  return {authorizeUrl:`${AUTH}?${params}`};
}

async function readJson(response) {
  const declared=Number(response.headers.get('content-length'));
  if(Number.isFinite(declared)&&declared>32768)throw new Error('OAuth response too large');
  const reader=response.body?.getReader();if(!reader)return {};
  let size=0,parts=[];
  for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>32768){await reader.cancel().catch(()=>{});throw new Error('OAuth response too large');}parts.push(value);}
  const bytes=new Uint8Array(size);let off=0;for(const p of parts){bytes.set(p,off);off+=p.length;}
  return JSON.parse(new TextDecoder().decode(bytes));
}

export async function finishAppConnectionOAuth(env,url) {
  const state=url.searchParams.get('state')||'';
  const headers={'content-type':'text/html;charset=utf-8','cache-control':'no-store','content-security-policy':"default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",'referrer-policy':'no-referrer','x-content-type-options':'nosniff'};
  const fail=()=>new Response('<!doctype html><title>Honmaru</title><p>連携を完了できませんでした。アプリ設定から再接続してください。</p>',{status:400,headers});
  if(!/^[A-Za-z0-9_-]{43}$/.test(state))return fail();
  const stateHash=await sha(state);
  const s=await env.DB.prepare('DELETE FROM hx_app_connection_oauth_states WHERE state_hash=?1 RETURNING *').bind(stateHash).first().catch(()=>null);
  if(!s||s.expires_at<=new Date().toISOString()||`${url.origin}${url.pathname}`!==s.redirect_uri||url.searchParams.has('error'))return fail();
  const ownerMayUse=async()=>Boolean(await env.DB.prepare(`SELECT m.created_at AS since FROM memberships m JOIN hx_apps a ON a.org_id=m.org_id
    LEFT JOIN hx_app_access p ON p.org_id=a.org_id AND p.app_id=a.id
    WHERE m.org_id=?1 AND m.user_github_id=?2 AND a.id=?3 AND m.created_at=(SELECT created_at FROM memberships WHERE org_id=?1 AND user_github_id=?2)
      AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest' AND (COALESCE(p.visibility,'workspace')='workspace' OR a.created_by=?2)
      AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=?1 AND d.purge_started_at IS NOT NULL)
      AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=?1)`).bind(s.org_id,s.owner_id,s.app_id).first().catch(()=>null))
    && await mayUseApp(env.DB,s.org_id,s.app_id,s.owner_id);
  const ownerMayManage=async()=>{
    if(!await ownerMayUse())return false;
    if(await mayEditApp(env.DB,s.org_id,s.app_id,s.owner_id))return true;
    if(await hasExplicitAppPermission(env.DB,s.org_id,s.app_id,s.owner_id))return false;
    return allowed(env.DB,s.org_id,s.owner_id,'harness.delete_others');
  };
  if(!await ownerMayManage())return fail();
  const row=await env.DB.prepare(`SELECT * FROM hx_app_connections WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND name=?4 AND version=?5 AND endpoint=?6 AND method=?7 AND enabled=1 AND token=?8`)
    .bind(s.org_id,s.app_id,s.owner_id,s.connection_name,s.connection_version,s.endpoint,s.method,s.credential_ciphertext).first().catch(()=>null);
  if(!row)return fail();
  const code=url.searchParams.get('code')||'';if(!safe(code,4096))return fail();
  const verifier=await openField(s.code_verifier,aad.appConnectionOAuthVerifier(s.org_id,s.state_hash));
  const secret=await openField(s.client_secret,`hx_app_connection_oauth_states.client_secret:${s.org_id}:${s.state_hash}`);
  if(!verifier||!secret)return fail();
  let tokens;
  try {
    const response=await fetch(TOKEN,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(12000),headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({code,client_id:s.client_id,client_secret:secret,redirect_uri:s.redirect_uri,code_verifier:verifier,grant_type:'authorization_code'})});
    if(!response.ok||response.status>=300&&response.status<400)return fail();tokens=await readJson(response);
  } catch{return fail();}
  if(!safe(tokens.access_token,8192)||!safe(tokens.refresh_token,8192))return fail();
  if(!await ownerMayManage())return fail();
  const current=await env.DB.prepare(`SELECT * FROM hx_app_connections WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND name=?4 AND version=?5 AND token=?6 AND enabled=1`)
    .bind(s.org_id,s.app_id,s.owner_id,s.connection_name,s.connection_version,s.credential_ciphertext).first().catch(()=>null);
  if(!current)return fail();
  const cfg=await decodeAppOAuth(s.org_id,s.app_id,s.owner_id,s.connection_name,current.token);if(!cfg)return fail();
  const next={...cfg,accessToken:tokens.access_token,refreshToken:tokens.refresh_token,expiresAt:Date.now()+Math.min(Math.max(Number(tokens.expires_in)||3600,60),31536000)*1000,requiresReauthorization:false};
  const sealed=await encodeAppOAuth(env,s.org_id,s.app_id,s.owner_id,s.connection_name,next);
  if(!await ownerMayManage())return fail();
  const saved=await env.DB.prepare(`UPDATE hx_app_connections SET token=?9 WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND name=?4 AND version=?5 AND endpoint=?6 AND method=?7 AND token=?8 AND enabled=1
    AND EXISTS(SELECT 1 FROM memberships m JOIN hx_apps a ON a.org_id=m.org_id
      LEFT JOIN hx_app_access p ON p.org_id=a.org_id AND p.app_id=a.id
      LEFT JOIN hx_app_person_access person ON person.org_id=a.org_id AND person.app_id=a.id AND person.user_github_id=m.user_github_id
      WHERE m.org_id=?1 AND m.user_github_id=?3 AND a.id=?2 AND a.deleted_at IS NULL
        AND LOWER(TRIM(COALESCE(m.role,'guest')))!='guest'
        AND (COALESCE(p.visibility,'workspace')='workspace' OR a.created_by=?3)
        AND NOT EXISTS(SELECT 1 FROM workspace_deletions d WHERE d.org_id=?1 AND d.purge_started_at IS NOT NULL)
        AND NOT EXISTS(SELECT 1 FROM workspace_tombstones t WHERE t.org_id=?1)
        AND (a.created_by=?3 OR person.permission='edit'
          OR (person.user_github_id IS NULL AND LOWER(TRIM(COALESCE(m.role,''))) IN ('owner','admin'))))`)
    .bind(s.org_id,s.app_id,s.owner_id,s.connection_name,s.connection_version,s.endpoint,s.method,s.credential_ciphertext,sealed).run().catch(()=>null);
  if(!saved?.meta?.changes)return fail();
  return new Response('<!doctype html><title>Honmaru</title><p>Google連携が完了しました。このタブを閉じてアプリに戻ってください。</p>',{headers});
}

export async function refreshGoogleToken(env,orgId,appId,ownerId,name,row,config,authorize=async()=>true) {
  if(config.accessToken&&config.expiresAt>Date.now()+30000)return config;
  if(!config.refreshToken||config.requiresReauthorization)return null;
  // A lease prevents parallel requests from consuming a rotating refresh token.
  // An expired lease is ambiguous: never replay the possibly consumed token.
  for(let attempt=0;attempt<30;attempt++){
    if(!await authorize())return null;
    const current=await env.DB.prepare('SELECT token,version,endpoint,method,enabled FROM hx_app_connections WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND name=?4')
      .bind(orgId,appId,String(ownerId),name).first().catch(()=>null);
    if(!current||current.version!==row.version||current.endpoint!==row.endpoint||current.method!==row.method||current.enabled!==1)return null;
    const live=await decodeAppOAuth(orgId,appId,ownerId,name,current.token);if(!live)return null;
    if(live.accessToken&&live.expiresAt>Date.now()+30000)return live;
    if(live.requiresReauthorization)return null;
    if(live.refreshLeaseUntil>Date.now()) { await new Promise(r=>setTimeout(r,100));continue; }
    if(live.refreshLeaseUntil){const reauth=await encodeAppOAuth(env,orgId,appId,ownerId,name,{...live,requiresReauthorization:true});await env.DB.prepare('UPDATE hx_app_connections SET token=?5 WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND name=?4 AND token=?6').bind(orgId,appId,String(ownerId),name,reauth,current.token).run().catch(()=>{});return null;}
    const lease={...live,refreshLeaseUntil:Date.now()+20000};const leased=await encodeAppOAuth(env,orgId,appId,ownerId,name,lease);
    const won=await env.DB.prepare('UPDATE hx_app_connections SET token=?5 WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND name=?4 AND token=?6 AND version=?7 AND enabled=1')
      .bind(orgId,appId,String(ownerId),name,leased,current.token,row.version).run().catch(()=>null);
    if(!won?.meta?.changes)continue;
    if(!await authorize())return null;
    let tokens;
    try {const response=await fetch(TOKEN,{method:'POST',redirect:'manual',signal:AbortSignal.timeout(12000),headers:{accept:'application/json','content-type':'application/x-www-form-urlencoded'},body:new URLSearchParams({client_id:live.clientId,client_secret:live.clientSecret,grant_type:'refresh_token',refresh_token:live.refreshToken})});if(!response.ok||response.status>=300&&response.status<400)throw new Error();tokens=await readJson(response);}
    catch {const reauth=await encodeAppOAuth(env,orgId,appId,ownerId,name,{...lease,refreshLeaseUntil:0,requiresReauthorization:true});await env.DB.prepare('UPDATE hx_app_connections SET token=?5 WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND name=?4 AND token=?6').bind(orgId,appId,String(ownerId),name,reauth,leased).run().catch(()=>{});return null;}
    if(!safe(tokens.access_token,8192)||!await authorize())return null;
    const next=await encodeAppOAuth(env,orgId,appId,ownerId,name,{...live,accessToken:tokens.access_token,refreshToken:safe(tokens.refresh_token,8192)?tokens.refresh_token:live.refreshToken,expiresAt:Date.now()+Math.min(Math.max(Number(tokens.expires_in)||3600,60),31536000)*1000,refreshLeaseUntil:0,requiresReauthorization:false});
    const saved=await env.DB.prepare('UPDATE hx_app_connections SET token=?5 WHERE org_id=?1 AND app_id=?2 AND created_by=?3 AND name=?4 AND token=?6 AND version=?7 AND enabled=1').bind(orgId,appId,String(ownerId),name,next,leased,row.version).run().catch(()=>null);
    return saved?.meta?.changes?JSON.parse(await openField(next,aad.appConnectionOAuthClient(orgId,appId,ownerId,name))):null;
  }
  return null;
}
