import { getTable, listRows } from './tables.js';
import { sealField, openField, aad, isSealed } from '../secrets.js';
import { getApp } from './apps.js';

const fail=(error,status=400)=>({error,status});
const at=()=>new Date().toISOString();
const b64url=(bytes)=>btoa(String.fromCharCode(...bytes)).replace(/\+/g,'-').replace(/\//g,'_').replace(/=+$/,'');
async function digest(value){return [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value)))].map(x=>x.toString(16).padStart(2,'0')).join('')}
const context=(orgId,appId)=>'hx_app_public_shares.token:'+orgId+':'+appId;

export async function publicShareSettings(db,orgId,appId){
 const {results=[]}=await db.prepare("SELECT id,app_id AS appId,app_version AS appVersion,data_scope AS dataScope,token_ciphertext AS tokenCiphertext,created_at AS createdAt FROM hx_app_public_shares WHERE org_id=?1 AND app_id=?2 AND revoked_at IS NULL").bind(orgId,appId).all();
 const share=results[0];
 if(!share)return {share:null};
 const token=await openField(share.tokenCiphertext,context(orgId,appId));
 let scope=[];try{scope=JSON.parse(share.dataScope||'[]')}catch{}
 return {share:{id:share.id,appVersion:share.appVersion,dataScope:scope,createdAt:share.createdAt,url:typeof token==='string'?token:null}};
}
export async function publicShareOptions(db,orgId,appId){
 const app=await getApp(db,orgId,appId);if(!app)return fail('No such app.',404);
 const related=await db.prepare('SELECT entity_key AS key,table_id AS tableId FROM hx_app_entities WHERE org_id=?1 AND app_id=?2 ORDER BY entity_key').bind(orgId,appId).all();
 const refs=[{key:'primary',tableId:app.tableId},...(related.results||[]).filter(x=>x.key!=='primary'&&x.tableId!==app.tableId)];
 const entities=[];
 for(const ref of refs){const table=await getTable(db,orgId,ref.tableId);if(table)entities.push({key:ref.key,name:table.name,fields:(table.columns||[]).map(c=>({id:c.id,name:c.name,type:c.type}))})}
 return {entities};
}
export async function createPublicAppShare(db,orgId,appId,by,input){
 if(input.publicDataConfirmed!==true)return fail('Confirm that anyone with the link can read the selected fields.',409);
 const app=await getApp(db,orgId,appId);if(!app)return fail('No such app.',404);
 const access=await db.prepare('SELECT visibility,version FROM hx_app_access WHERE org_id=?1 AND app_id=?2').bind(orgId,appId).first();
 if(!Number.isSafeInteger(input.accessVersion)||Number(input.accessVersion)!==Number(access?.version||0))return fail('Sharing changed. Reload before creating a public link.',409);
 const current=await db.prepare('SELECT version,definition FROM hx_app_versions WHERE org_id=?1 AND app_id=?2 ORDER BY version DESC LIMIT 1').bind(orgId,appId).first();
 const version=Number(current?.version||0);if(!version)return fail('Publish a version before making a public link.',409);
 let pinned;try{pinned=JSON.parse(current.definition||'{}')}catch{return fail('The saved app version is invalid.',409)}
 if(typeof pinned.custom?.published!=='string'||!pinned.custom.published.trim()||pinned.custom.published.length>120000)return fail('Publish the Custom App before creating a public link.',409);
 if(input.appVersion!==version)return fail('App version changed. Reload before sharing.',409);
 if(!Array.isArray(input.entities)||input.entities.length<1||input.entities.length>10)return fail('Choose at least one public entity.');
 const related=await db.prepare('SELECT entity_key AS key,table_id AS tableId FROM hx_app_entities WHERE org_id=?1 AND app_id=?2').bind(orgId,appId).all();
 const refs=new Map([['primary',app.tableId],...(related.results||[]).map(x=>[x.key,x.tableId])]);
 const scope=[];
 for(const selected of input.entities){
  const key=String(selected?.entity||'');
  if(!refs.has(key)||!Array.isArray(selected.fields)||selected.fields.length<1||selected.fields.length>50)return fail('Invalid public entity or fields.');
  const table=await getTable(db,orgId,refs.get(key));if(!table)return fail('App data unavailable.',404);
  const allowed=new Set((table.columns||[]).map(c=>c.id)),fields=[...new Set(selected.fields.map(String))];
  if(fields.some(id=>!allowed.has(id)))return fail('Invalid public field selection.');
  scope.push({entity:key,tableId:refs.get(key),fields});
 }
 if(new Set(scope.map(x=>x.entity)).size!==scope.length)return fail('Duplicate public entity.');
 const token=b64url(crypto.getRandomValues(new Uint8Array(32))),id='aps_'+b64url(crypto.getRandomValues(new Uint8Array(12))),tokenHash=await digest(token);
 const encrypted=await sealField(token,context(orgId,appId),orgId);if(!isSealed(encrypted))return fail('Secure link storage is unavailable.',503);
 const dataScope=JSON.stringify(scope),createdAt=at();
 const statements=[
  db.prepare('UPDATE hx_app_public_shares SET revoked_at=?3 WHERE org_id=?1 AND app_id=?2 AND revoked_at IS NULL AND COALESCE((SELECT version FROM hx_app_access WHERE org_id=?1 AND app_id=?2),0)=?4').bind(orgId,appId,createdAt,Number(input.accessVersion)),
  db.prepare('INSERT INTO hx_app_public_shares(id,org_id,app_id,token_hash,token_ciphertext,app_version,data_scope,created_by,created_at) SELECT ?1,?2,?3,?4,?5,?6,?7,?8,?9 WHERE COALESCE((SELECT version FROM hx_app_access WHERE org_id=?2 AND app_id=?3),0)=?10').bind(id,orgId,appId,tokenHash,encrypted,version,dataScope,String(by),createdAt,Number(input.accessVersion))
 ];
 try{const result=await db.batch(statements);if(!result?.[1]?.meta?.changes)return fail('Sharing changed. Reload before creating a public link.',409)}catch{return fail('A public link changed concurrently. Reload and retry.',409)}
 return {share:{id,appVersion:version,dataScope:JSON.parse(dataScope),createdAt,url:'/app-shares/'+token}};
}
export async function revokePublicAppShare(db,orgId,appId,shareId){
 const result=await db.prepare('UPDATE hx_app_public_shares SET revoked_at=?4 WHERE org_id=?1 AND app_id=?2 AND id=?3 AND revoked_at IS NULL').bind(orgId,appId,shareId,at()).run();
 return result.meta?.changes?{revoked:true}:fail('Public link has changed. Reload.',409);
}
export async function readPublicAppShare(db,token,origin){
 if(typeof token!=='string'||token.length<40||token.length>100)return fail('Not found.',404);
 const hash=await digest(token);
 const share=await db.prepare(`SELECT s.org_id AS orgId,s.app_id AS appId,s.app_version AS appVersion,s.data_scope AS dataScope,
   v.definition AS definition,a.name AS name,a.icon AS icon,a.table_id AS tableId
   FROM hx_app_public_shares s JOIN hx_apps a ON a.org_id=s.org_id AND a.id=s.app_id
   JOIN hx_app_versions v ON v.org_id=s.org_id AND v.app_id=s.app_id AND v.version=s.app_version
   WHERE s.token_hash=?1 AND s.revoked_at IS NULL`).bind(hash).first();
 if(!share)return fail('Not found.',404);
 let scope;let definition;try{scope=JSON.parse(share.dataScope);definition=JSON.parse(share.definition)}catch{return fail('Not found.',404)}
 if(!Array.isArray(scope)||!scope.length||scope.length>10)return fail('Not found.',404);
 const related=await db.prepare('SELECT entity_key AS key,table_id AS tableId FROM hx_app_entities WHERE org_id=?1 AND app_id=?2').bind(share.orgId,share.appId).all();
 const attached=new Map([['primary',share.tableId],...(related.results||[]).map(x=>[x.key,x.tableId])]);
 const entities=[];
 for(const selected of scope){
  if(typeof selected?.tableId!=='string'||attached.get(selected?.entity)!==selected.tableId||!Array.isArray(selected.fields)||!selected.fields.length)return fail('Not found.',404);
  const table=await getTable(db,share.orgId,selected.tableId);if(!table)return fail('Not found.',404);
  const fields=selected.fields;
  const allowed=new Set((table.columns||[]).map(c=>c.id));if(fields.some(x=>!allowed.has(x)))return fail('Not found.',404);
  const result=await listRows(db,share.orgId,selected.tableId,{limit:5000});if(result.error)return fail('Unavailable.',503);
  const rows=(result.rows||[]).map(row=>({values:Object.fromEntries(fields.map(field=>[field,row.values?.[field]??null]))}));
  entities.push({key:selected.entity,table:{name:table.name,columns:table.columns.filter(c=>fields.includes(c.id)).map(c=>({id:c.id,name:c.name,type:c.type}))},rows});
 }
 const primary=entities.find(x=>x.key==='primary')||entities[0];
 const versionDefinition=definition;
 const publicDefinition=versionDefinition.custom?.published;
 if(typeof publicDefinition!=='string'||publicDefinition.length>120000)return fail('Not found.',404);
 const title=typeof versionDefinition.name==='string'?versionDefinition.name:share.name;
 const icon=typeof versionDefinition.icon==='string'?versionDefinition.icon:share.icon||'📋';
 const payload=JSON.stringify({name:title,icon,appVersion:share.appVersion,html:publicDefinition,table:primary.table,rows:primary.rows,entities}).replace(/</g,'\\u003c').replace(/\\u2028/g,'\\u2028').replace(/\\u2029/g,'\\u2029');
 if(payload.length>1500000)return fail('Public app snapshot exceeds the 1.5 MB page limit.',413);
 return {html:publicShell(payload,origin)};
}
function publicShell(payload,origin){
 const safe=JSON.stringify(payload).replace(/</g,'\\u003c');
 const runner=JSON.stringify(String(origin||'')+'/custom-app-runner?v=4').replace(/</g,'\\u003c');
 return `<!doctype html><html><head><meta charset="utf-8"><meta name="referrer" content="no-referrer"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Published app</title></head><body style="margin:0;font-family:system-ui"><header id="title" style="padding:12px 16px;border-bottom:1px solid #ddd"></header><iframe id="runner" title="Published app" sandbox="allow-scripts" referrerpolicy="no-referrer" style="border:0;width:100%;height:calc(100vh - 52px)"></iframe><script>
const p=JSON.parse(${safe}),frame=document.getElementById('runner'),renderId=crypto.randomUUID();frame.src=${runner};document.title=p.name;document.getElementById('title').textContent=(p.icon||'📋')+' '+p.name;
function reply(id,value,error){frame.contentWindow.postMessage({type:'honmaru:result',id,value,error},'*')}
addEventListener('message',e=>{if(e.source!==frame.contentWindow||!e.data)return;const m=e.data;if(m.type==='honmaru:ready'){frame.contentWindow.postMessage({type:'honmaru:init',renderId,theme:'system',html:'<meta name="color-scheme" content="light dark"><style>body{background:Canvas;color:CanvasText}</style>'+p.html},'*');return}if(m.type!=='honmaru:request'||typeof m.id!=='string'||m.id.length>80)return;if(m.operation==='read'){reply(m.id,{table:p.table,rows:p.rows});return}if(m.operation==='entity'){const entity=p.entities.find(item=>item.key===m.args?.entity);if(entity){reply(m.id,{table:entity.table,rows:entity.rows});return}reply(m.id,undefined,'No such public entity.');return}reply(m.id,undefined,'Published app is read-only.')});
</script></body></html>`;
}
