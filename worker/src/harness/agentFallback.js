import {getUserByLogin} from '../db.js';
import {listMembers} from '../team.js';
import {resolveChannel,postMessage} from '../channels.js';
import {loadCopy} from '../copy.js';
import {serverText} from '../serverCopy.js';

const eventId=()=>crypto.randomUUID();

async function insertFallbackEvent(db,{orgId,agentId,gatewayId,ownerLogin,state,version,at,id}){
 await db.prepare(`INSERT OR IGNORE INTO hx_agent_fallback_events
   (id,org_id,agent_id,gateway_id,owner_login,state,version,created_at)
   SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS(
     SELECT 1 FROM hx_agent_fallback_state s WHERE s.org_id=?2 AND s.agent_id=?3
       AND s.gateway_id=?4 AND s.current_state=?6 AND s.version=?7)
   AND NOT EXISTS(SELECT 1 FROM hx_agent_fallback_events e WHERE e.org_id=?2 AND e.agent_id=?3 AND e.version=?7)`)
   .bind(id,orgId,agentId,gatewayId,ownerLogin,state,version,at).run();
}

/** Record a local/workspace transition. Only state changes create a durable DM event. */
export async function recordAgentFallbackState(db,{orgId,agentId,gatewayId,ownerLogin,state,at=Date.now()}){
 if(!orgId||!agentId||!gatewayId||!ownerLogin||!['node','workspace'].includes(state))return false;
 const stamp=new Date(at).toISOString();
 let current=await db.prepare('SELECT gateway_id,current_state,version FROM hx_agent_fallback_state WHERE org_id=?1 AND agent_id=?2').bind(orgId,agentId).first();
 if(!current){
   const id=eventId();
   await db.batch([
     db.prepare(`INSERT OR IGNORE INTO hx_agent_fallback_state(org_id,agent_id,gateway_id,current_state,version,updated_at)
       VALUES(?1,?2,?3,?4,1,?5)`).bind(orgId,agentId,gatewayId,state,stamp),
     ...(state==='workspace'?[db.prepare(`INSERT OR IGNORE INTO hx_agent_fallback_events(id,org_id,agent_id,gateway_id,owner_login,state,version,created_at)
       SELECT ?1,?2,?3,?4,?5,'workspace',1,?6 WHERE EXISTS(SELECT 1 FROM hx_agent_fallback_state s
       WHERE s.org_id=?2 AND s.agent_id=?3 AND s.gateway_id=?4 AND s.current_state='workspace' AND s.version=1)
       AND NOT EXISTS(SELECT 1 FROM hx_agent_fallback_events e WHERE e.org_id=?2 AND e.agent_id=?3 AND e.version=1)`)
       .bind(id,orgId,agentId,gatewayId,ownerLogin,stamp)]:[]),
   ]);
   current=await db.prepare('SELECT gateway_id,current_state,version FROM hx_agent_fallback_state WHERE org_id=?1 AND agent_id=?2').bind(orgId,agentId).first();
 }
 if(!current)return false;
 if(current.current_state===state&&current.gateway_id===gatewayId){
   if(state==='workspace')await insertFallbackEvent(db,{orgId,agentId,gatewayId,ownerLogin,state,version:Number(current.version),at:stamp,id:eventId()});
   return false;
 }
 const expected=Number(current.version),version=expected+1,id=eventId();
 await db.batch([
   db.prepare(`UPDATE hx_agent_fallback_state SET gateway_id=?3,current_state=?4,version=?5,updated_at=?6
     WHERE org_id=?1 AND agent_id=?2 AND gateway_id=?7 AND current_state=?8 AND version=?9`)
     .bind(orgId,agentId,gatewayId,state,version,stamp,current.gateway_id,current.current_state,expected),
   db.prepare(`INSERT OR IGNORE INTO hx_agent_fallback_events(id,org_id,agent_id,gateway_id,owner_login,state,version,created_at)
     SELECT ?1,?2,?3,?4,?5,?6,?7,?8 WHERE EXISTS(SELECT 1 FROM hx_agent_fallback_state s
       WHERE s.org_id=?2 AND s.agent_id=?3 AND s.gateway_id=?4 AND s.current_state=?6 AND s.version=?7)`)
     .bind(id,orgId,agentId,gatewayId,ownerLogin,state,version,stamp),
 ]);
 return true;
}

/** A node claim that follows a real disconnect can switch eligible Agents back immediately. */
export async function restoreAgentsForGateway(env,{orgId,gatewayId,at=Date.now()}){
 const {results=[]}=await env.DB.prepare(`SELECT s.agent_id,a.owner_login,t.remote FROM hx_agent_fallback_state s
   JOIN custom_agents a ON a.org_id=s.org_id AND a.id=s.agent_id AND a.deleted_at IS NULL
   JOIN ai_teammates t ON t.org_id=a.org_id AND t.agent_id=a.id AND t.enabled=1
   JOIN hx_gateway_acp_agents ga ON ga.org_id=s.org_id AND ga.gateway_id=s.gateway_id
     AND ga.agent_key=CASE WHEN json_valid(t.remote) THEN json_extract(t.remote,'$.agentKey') ELSE NULL END
   WHERE s.org_id=?1 AND s.gateway_id=?2 AND s.current_state='workspace' AND a.owner_login IS NOT NULL
     AND CASE WHEN json_valid(t.remote) THEN json_extract(t.remote,'$.gatewayId') ELSE NULL END=?2
     AND CASE WHEN json_valid(t.remote) THEN json_extract(t.remote,'$.fallbackToWorkspaceAI') ELSE NULL END=1`)
   .bind(orgId,gatewayId).all();
 for(const row of results)await recordAgentFallbackState(env.DB,{orgId,agentId:row.agent_id,gatewayId,ownerLogin:row.owner_login,state:'node',at});
 return results.length;
}

/** Drain transition DMs. Stable client ids make posting safe to retry after a lost relay acknowledgement. */
export async function drainAgentFallbackNotifications(env,broadcast,{limit=25}={}){
 if(!broadcast)broadcast=(await import('../channelRoutes.js')).broadcastStored;
 const {results=[]}=await env.DB.prepare(`SELECT * FROM hx_agent_fallback_events WHERE status='pending'
   ORDER BY created_at,id LIMIT ?1`).bind(Math.max(1,Math.min(100,Number(limit)||25))).all();
 let delivered=0;
 for(const event of results){
   try{
     const owner=await getUserByLogin(env.DB,event.owner_login);
     const agent=await env.DB.prepare(`SELECT id,handle,name,owner_login FROM custom_agents
       WHERE org_id=?1 AND id=?2 AND deleted_at IS NULL AND owner_login=?3`)
       .bind(event.org_id,event.agent_id,event.owner_login).first();
     const member=owner&&await env.DB.prepare(`SELECT 1 FROM memberships WHERE org_id=?1 AND user_github_id=?2
       AND LOWER(TRIM(COALESCE(role,'guest')))!='guest'`).bind(event.org_id,String(owner.github_id)).first();
     if(!owner||!agent||!member){
       await env.DB.prepare(`UPDATE hx_agent_fallback_events SET status='cancelled',updated_at=?3
         WHERE org_id=?1 AND id=?2 AND status='pending'`).bind(event.org_id,event.id,new Date().toISOString()).run();
       continue;
     }
     const members=await listMembers(env.DB,event.org_id,owner.github_id);
     const resolved=await resolveChannel(env.DB,event.org_id,owner,`ag:${event.agent_id}`,members);
     if(!resolved||resolved.kind!=='agent'||resolved.key!==`ag:${event.agent_id}|${event.owner_login}`){
       await env.DB.prepare(`UPDATE hx_agent_fallback_events SET status='cancelled',updated_at=?3
         WHERE org_id=?1 AND id=?2 AND status='pending'`).bind(event.org_id,event.id,new Date().toISOString()).run();
       continue;
     }
     const locale=await loadCopy(env,owner.locale||'en',{orgId:event.org_id});
     const key=event.state==='workspace'?'agent.workspaceFallbackNotice':'agent.localFallbackNotice';
     const body=serverText(locale,key,{name:agent.name||agent.handle||'Agent'});
     const clientId=`tmp-${String(event.id).replace(/[^0-9a-z-]/gi,'').toLowerCase().slice(0,76)}`;
     const out=await postMessage(env.DB,{orgId:event.org_id,key:resolved.key,authorLogin:`agent:${agent.id}`,body,kind:'agent',clientId});
     if(out.error||!out.row)throw new Error(out.error||'Could not save the Agent runtime notice.');
     if(broadcast)await broadcast(env,event.org_id,resolved.key,out.row);
     await env.DB.prepare(`UPDATE hx_agent_fallback_events SET status='delivered',updated_at=?3
       WHERE org_id=?1 AND id=?2 AND status='pending'`).bind(event.org_id,event.id,new Date().toISOString()).run();
     delivered++;
   }catch(error){
     await env.DB.prepare(`UPDATE hx_agent_fallback_events SET attempts=attempts+1,updated_at=?3
       WHERE org_id=?1 AND id=?2 AND status='pending'`).bind(event.org_id,event.id,new Date().toISOString()).run().catch(()=>{});
     console.error('Agent fallback notification deferred',String(error?.message||error).slice(0,160));
   }
 }
 return delivered;
}
