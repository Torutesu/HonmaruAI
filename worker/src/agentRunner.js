import {runQueuedHandoff,settleHandoff} from './harness/agentHandoffRun.js';
import {settleInitialAssignments} from './harness/agentAssignmentSettlement.js';
import {runTrackedAgentJob} from './agentJobResult.js';
import {readAgentJobStatuses, validAgentStatusInput} from './agentJobStatus.js';
import {agentExecutionGrant,agentExecutionAuthorizer} from './agentExecutionGrant.js';
import { queueRoomHookRetry } from './harness/roomHookRetry.js';
import { roomHookExecutionGrant } from './harness/roomHookExecutionGrant.js';
/// Where agents answer from in production. A request may keep working for
/// only half a minute after it has answered (ctx.waitUntil); an agent that
/// searches, reads pages and searches again needs longer. So the message's
/// request hands the job here and returns; this Durable Object — one per
/// workspace — keeps it and answers from its alarm, which may run for
/// minutes. Normal jobs retain a durable result so interrupted work is
/// distinguishable from completed work without repeating external operations.

import { runRoomHookAgents } from "./harness/roomHookAgentRun.js";
import { runAgents } from "./channelRoutes.js";
import { runProxy } from "./proxy.js";
import { useSecretKey } from "./secrets.js";
import { useMirrorEnv } from "./store/mirror.js";
import { useMediaEnv } from "./mediaToken.js";

const MAX_JOBS = 50;
const jobKind = job => job.kind === "proxy" ? "proxy" : job.kind === "room_hook" ? "room_hook" : job.kind === "handoff" ? "handoff" : "agent";

export class AgentRunner {
  constructor(state, env) {
    useSecretKey(env);
    useMirrorEnv(env);
    useMediaEnv(env);
    this.state = state;
    this.env = env;
    // A stop request can arrive while an alarm is awaiting a provider. Keep
    // one controller per assignment generation so the route can interrupt
    // that request without stopping unrelated agents in the workspace.
    this.activeAssignments = new Map();
  }

  assignmentKey({orgId,assignmentId,generation}) {
    return JSON.stringify([orgId,assignmentId,generation]);
  }

  registerAssignment(identity,controller) {
    const key=this.assignmentKey(identity);
    const controllers=this.activeAssignments.get(key)||new Set();
    controllers.add(controller);
    this.activeAssignments.set(key,controllers);
    return ()=>{
      controllers.delete(controller);
      if(!controllers.size)this.activeAssignments.delete(key);
    };
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === 'POST' && url.pathname === '/agent-status') {
      const input = await request.json().catch(() => null);
      if (!validAgentStatusInput(input)) return new Response('Bad request', {status: 400});
      return Response.json({results: await readAgentJobStatuses(this.state.storage, input)}, {headers: {'cache-control': 'no-store'}});
    }
    if (request.method === 'POST' && url.pathname === '/cancel-assignment') {
      const input=await request.json().catch(()=>null);
      if(typeof input?.orgId!=='string'||!input.orgId||input.orgId.length>200||typeof input.assignmentId!=='string'||!input.assignmentId||input.assignmentId.length>100||!Number.isSafeInteger(input.generation)||input.generation<0||input.generation>8)return new Response('Bad request',{status:400});
      const controllers=this.activeAssignments.get(this.assignmentKey(input));
      for(const controller of controllers||[])controller.abort();
      return Response.json({cancelled:true,active:Boolean(controllers?.size)},{headers:{'cache-control':'no-store'}});
    }
    if(request.method==='POST'&&url.pathname==='/room-hook-retry') {
      const input=await request.json().catch(()=>null);
      if(typeof input?.orgId!=='string'||typeof input?.rowId!=='string'||typeof input?.actorId!=='string')return new Response('Bad request',{status:400});
      const grant=await roomHookExecutionGrant(this.env.DB,input.orgId,input.rowId);
      if(!grant||grant.creatorId!==input.actorId)return new Response('Access changed',{status:403});
      const active=await this.env.DB.prepare("SELECT 1 FROM ai_teammate_runs WHERE org_id=?1 AND room_hook_source=?2 AND status='running' LIMIT 1").bind(input.orgId,input.rowId).first();
      if(active)return new Response('An external agent is still running',{status:409});
      const result=await queueRoomHookRetry(this.state.storage,input);
      if(result.status===202&&!(await this.state.storage.getAlarm()))await this.state.storage.setAlarm(Date.now());
      return Response.json({queued:result.status===202},{status:result.status});
    }
    if (request.method === 'POST' && url.pathname === '/room-hook-status') {
      const input = await request.json().catch(()=>null);
      if (typeof input?.orgId !== 'string' || !Array.isArray(input.rowIds) || input.rowIds.length > 20 || input.rowIds.some(id=>typeof id!=='string'||id.length>100)) return new Response('Bad request',{status:400});
      const results = [];
      for (const rowId of input.rowIds) {
        const result = await this.state.storage.get(`result:${JSON.stringify([input.orgId,'room_hook',rowId])}`);
        const receipt = result ? null : await this.state.storage.get(`accepted:${JSON.stringify([input.orgId,'room_hook',rowId,null])}`);
        results.push({rowId,status:result?.status || (receipt?'queued':'unknown'),answered:Number(result?.answered)||0,...(Number.isSafeInteger(result?.at)?{version:result.at}:{})});
      }
      return Response.json({results},{headers:{'cache-control':'no-store'}});
    }
    if (request.method !== "POST" || url.pathname !== "/enqueue") return new Response("Not found", { status: 404 });
    const job = await request.json().catch(() => null);
    // A proxy's job carries whose agent it is, not a session: it works for
    // the person mentioned, not the person who wrote.
    if (!job?.orgId || !job?.rowId || (job.kind != null && !["proxy","room_hook","handoff","agent"].includes(job.kind)) || (job.kind === "proxy" ? !job.owner : job.kind !== "room_hook" && job.kind !== "handoff" && !job.token)) return new Response("Bad job", { status: 400 });
    // The same message may reach enqueue again after a response is lost.
    // Keep the receipt after dequeue too: a running or completed request must
    // not start another paid run. A new request uses a new message ID.
    const receipt = `accepted:${JSON.stringify([job.orgId, jobKind(job), job.rowId, job.kind === "proxy" ? job.owner : null])}`;
    const accepted = await this.state.storage.transaction(async storage => {
      if (await storage.get(receipt)) return true;
      const waiting = await storage.list({ prefix: "job:", limit: MAX_JOBS + 1 });
      // Recognize jobs queued by the previous version before receipts existed.
      const existing = [...waiting.values()].some(value => value.orgId === job.orgId && value.rowId === job.rowId &&
        jobKind(value) === jobKind(job) && (job.kind !== "proxy" || value.owner === job.owner));
      if (!existing && waiting.size >= MAX_JOBS) return false;
      const queuedAt = Date.now();
      if (!existing) await storage.put(`job:${queuedAt}:${jobKind(job)}:${job.rowId}${job.kind === "proxy" ? `:${job.owner}` : ""}`, { ...job, queuedAt });
      await storage.put(receipt, { acceptedAt: queuedAt });
      return true;
    });
    if (!accepted) return new Response("Busy", { status: 503 });
    if (!(await this.state.storage.getAlarm())) await this.state.storage.setAlarm(Date.now());
    return new Response("Queued", { status: 202 });
  }

  async runRoomHook(key,job) {
    const stamp = () => Math.max(Date.now(),Number(job.queuedAt || 0)+1);
    const resultKey = `result:${JSON.stringify([job.orgId,"room_hook",job.rowId])}`;
    const previous = await this.state.storage.get(resultKey);
    if (previous) {
      // A process interruption after execution starts has an unknown external
      // outcome. Do not silently repeat a potentially billed model call.
      if (previous.status === 'running') await this.state.storage.put(resultKey,{status:'interrupted',at:stamp()});
      await this.state.storage.delete(key);
      return;
    }
    await this.state.storage.put(resultKey,{status:'running',at:stamp()});
    try {
      const result = await runRoomHookAgents(this.env,job);
      await this.state.storage.put(resultKey,{...result,at:stamp()});
    } catch {
      await this.state.storage.put(resultKey,{status:'failed',at:stamp()});
    }
    await this.state.storage.delete(key);
  }

  async alarm() {
    const jobs = await this.state.storage.list({ prefix: "job:", limit: 10 });
    // Legacy proxy jobs retain their dequeue-first behavior. Normal and hook
    // jobs remain queued until their result has been persisted.
    await this.state.storage.delete([...jobs].filter(([,job])=>job.kind === "proxy").map(([key])=>key));
    let retry=false;
    await Promise.allSettled([...jobs].map(([key,job]) => (job.kind === "room_hook" ? this.runRoomHook(key,job) : job.kind === "proxy" ? runProxy(this.env, job) : job.kind === 'handoff' ? runTrackedAgentJob(this.state.storage,key,job,()=>runQueuedHandoff(this.env,job,{registerAssignment:(identity,controller)=>this.registerAssignment(identity,controller)}),{kind:'handoff',onSettled:(result,job)=>settleHandoff(this.env,job,result)}) : runTrackedAgentJob(this.state.storage,key,job,()=>runQueuedAgents(this.env,job,{details:true,registerAssignment:(identity,controller)=>this.registerAssignment(identity,controller)}),{onSettled:(result,job)=>settleInitialAssignments(this.env,job,result)})).catch((err) => {
      retry=true;
      console.error("queued agent failed", err?.message || err);
    })));
    const more = await this.state.storage.list({ prefix: "job:", limit: 1 });
    if (more.size) await this.state.storage.setAlarm(Date.now()+(retry ? 15000 : 0));
  }
}

/// One job: the message, who wrote it and where, found again from what was
/// kept — then the agents it calls answer.
export async function runQueuedAgents(env, { orgId, token, rowId, locale }, {details=false,registerAssignment=null}={}) {
  const request={orgId,token,rowId};
  const grant=await agentExecutionGrant(env,request);
  const respond=result=>details ? result : result.answered;
  if(!grant)return respond({status:'cancelled',answered:0});
  if(!grant.agents.length)return respond({status:'no_agents',answered:0});
  const authorize=agentExecutionAuthorizer(env,request,grant.row);
  const answered=await runAgents(env,{...grant,locale,authorize,durableExecution:true,registerAssignment});
  return respond({status:!answered && !await authorize() ? 'cancelled' : 'finished',answered});
}
