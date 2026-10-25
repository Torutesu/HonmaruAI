import {announceTo} from '../announce.js';
import {custom} from '../agui/events.js';
import {fileScopeAuthority} from './fileAuthority.js';

// Invalidation only: no filenames, room IDs, content or storage addresses.
// Clients must refetch through the normal live authorization path.
export async function announceFileChanged(env,orgId,fileId){
 if(!env.ORG_RELAY)return;
 try{
  const {results}=await env.DB.prepare(`SELECT DISTINCT person.login FROM hx_workspace_files f
   JOIN memberships recipient ON recipient.org_id=f.org_id JOIN users person ON person.github_id=recipient.user_github_id
   WHERE f.org_id=? AND f.id=? AND ${fileScopeAuthority('f.org_id','f.scope','recipient.user_github_id')}`).bind(orgId,fileId).all();
  for(let start=0;start<results.length;start+=100)await announceTo(env,orgId,results.slice(start,start+100).map(person=>({to:person.login,event:custom('workspace_files_changed',{})})));
 }catch{console.error('file update notification failed');}
}
