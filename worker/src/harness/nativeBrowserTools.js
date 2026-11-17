import { allowed } from '../permissions.js';
import { getMode } from './mode.js';
import { mayRunAgent } from './agents.js';
import { enqueueNativeBrowserAction, nativeBrowserActionAllowed } from './executions.js';

const actionProperties = {
  navigate: { type: 'object', properties: { type: { const: 'navigate' }, url: { type: 'string', maxLength: 2048 } }, required: ['type','url'], additionalProperties: false },
  click: { type: 'object', properties: { type: { const: 'click' }, x: { type: 'integer', minimum: 0, maximum: 4096 }, y: { type: 'integer', minimum: 0, maximum: 4096 } }, required: ['type','x','y'], additionalProperties: false },
  type: { type: 'object', properties: { type: { const: 'type' }, text: { type: 'string', maxLength: 2000 } }, required: ['type','text'], additionalProperties: false },
  press: { type: 'object', properties: { type: { const: 'press' }, key: { enum: ['Enter','Escape','Tab','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Backspace','Delete','Home','End','PageUp','PageDown'] } }, required: ['type','key'], additionalProperties: false },
  scroll: { type: 'object', properties: { type: { const: 'scroll' }, x: { type: 'integer', minimum: 0, maximum: 4096 }, y: { type: 'integer', minimum: 0, maximum: 4096 }, deltaX: { type: 'integer', minimum: -2000, maximum: 2000 }, deltaY: { type: 'integer', minimum: -2000, maximum: 2000 } }, required: ['type','x','y','deltaX','deltaY'], additionalProperties: false },
  screenshot: { type: 'object', properties: { type: { const: 'screenshot' } }, required: ['type'], additionalProperties: false },
  visible_text: { type: 'object', properties: { type: { const: 'visible_text' } }, required: ['type'], additionalProperties: false },
};
const sleep = (ms, signal) => new Promise(resolve => {
  if (signal?.aborted) return resolve();
  const timer=setTimeout(done,ms);
  function done(){clearTimeout(timer);signal?.removeEventListener('abort',done);resolve();}
  signal?.addEventListener('abort',done,{once:true});
});

export async function nativeBrowserAgentTools(env, { orgId, userId, login, agentId, browserContext }) {
  const mode=await getMode(env.DB,orgId).catch(()=>null);
  if (mode!=='harness' || !(await allowed(env.DB,orgId,userId,'harness.build').catch(()=>false))) return {};
  const profile=await env.DB.prepare(`SELECT p.native_browser_enabled,p.native_browser_gateway_id,a.id,a.scope,a.owner_login,a.provider
    FROM hx_agent_profiles p JOIN custom_agents a ON a.org_id=p.org_id AND a.id=p.agent_id
    WHERE p.org_id=?1 AND p.agent_id=?2 AND a.deleted_at IS NULL`).bind(orgId,agentId).first().catch(()=>null);
  if (!profile || Number(profile.native_browser_enabled)!==1 || !profile.native_browser_gateway_id || profile.provider ||
      !await mayRunAgent(env.DB,orgId,profile,userId).catch(()=>false)) return {};
  const gateway=await env.DB.prepare(`SELECT id FROM hx_gateways WHERE org_id=?1 AND id=?2 AND revoked_at IS NULL AND last_seen_at>?3`)
    .bind(orgId,profile.native_browser_gateway_id,Date.now()-90000).first().catch(()=>null);
  if (!gateway) return {};
  return {
    native_browser_action: {
      description: 'Use the explicitly enabled local Mac browser for one bounded action, then inspect its result. Available only in this private Harness Agent conversation. Actions can navigate websites, click, type, press a key, scroll, capture a screenshot, or read visible text. Each action is checked again against the current Agent setting and source message. Never enter passwords, payment details, or other secrets.',
      parameters: { type:'object', properties:{ action:{ oneOf:Object.values(actionProperties) } }, required:['action'], additionalProperties:false },
      strict: false,
      run: async ({ action }, { signal }={}) => {
        if (signal?.aborted) return 'Browser action stopped.';
        const current=await env.DB.prepare(`SELECT p.native_browser_enabled,p.native_browser_gateway_id,a.id,a.scope,a.owner_login,a.provider
          FROM hx_agent_profiles p JOIN custom_agents a ON a.org_id=p.org_id AND a.id=p.agent_id
          WHERE p.org_id=?1 AND p.agent_id=?2 AND a.deleted_at IS NULL`).bind(orgId,agentId).first().catch(()=>null);
        if (!current || Number(current.native_browser_enabled)!==1 || current.native_browser_gateway_id!==gateway.id || current.provider ||
            !await mayRunAgent(env.DB,orgId,current,userId).catch(()=>false)) return 'Browser access changed; no action was taken.';
        const queued=await enqueueNativeBrowserAction(env.DB,orgId,userId,{agentId,browserContext,browserAction:action});
        if (queued.error) return `Browser action was not queued: ${queued.error}`;
        const jobId=queued.job.id;
        const deadline=Date.now()+105000;
        let cancelled=false;
        const cancel=async()=>{
          if(cancelled)return; cancelled=true;
          await env.DB.prepare(`UPDATE hx_gateway_jobs SET status='cancelled',lease_hash=NULL,finished_at=?3
            WHERE org_id=?1 AND id=?2 AND created_by=?4 AND status IN ('queued','running')`).bind(orgId,jobId,Date.now(),String(userId)).run().catch(()=>{});
        };
        signal?.addEventListener('abort',cancel,{once:true});
        try {
          while (Date.now()<deadline && !signal?.aborted) {
            const row=await env.DB.prepare('SELECT * FROM hx_gateway_jobs WHERE org_id=?1 AND id=?2 AND created_by=?3').bind(orgId,jobId,String(userId)).first().catch(()=>null);
            if (!row) return 'Browser result is no longer available.';
            let payload; try { payload=JSON.parse(row.payload); } catch { return 'Browser authorization is invalid.'; }
            if (!await nativeBrowserActionAllowed(env.DB,row,payload).catch(()=>false)) {
              await cancel(); return 'Browser access changed; the action was stopped.';
            }
            if (['succeeded','failed','timed_out','cancelled'].includes(row.status)) {
              if (row.status!=='succeeded') return `Browser action ${row.status}.`;
              let result; try { result=JSON.parse(row.result||'{}'); } catch { return 'Browser returned an invalid result.'; }
              if (result.exitCode!==0) return `Browser action failed: ${String(result.stderr||'').slice(0,500)}`;
              try { return JSON.stringify(JSON.parse(result.stdout||'{}')).slice(0,14000); }
              catch { return 'Browser returned an invalid result.'; }
            }
            await sleep(350,signal);
          }
          if (signal?.aborted) { await cancel(); return 'Browser action stopped.'; }
          await cancel(); return 'Browser action timed out before a result was returned.';
        } finally { signal?.removeEventListener('abort',cancel); }
      },
    },
  };
}
