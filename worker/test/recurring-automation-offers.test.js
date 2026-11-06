import {env} from 'cloudflare:test';
import schemaSql from '../schema.sql?raw';
import {beforeEach,expect,test} from 'vitest';
import {createSession,upsertBusiness,upsertMembership,upsertUser} from '../src/db.js';
import {postMessage} from '../src/channels.js';
import {createWorkflow} from '../src/harness/workflows.js';
import {setMode} from '../src/harness/mode.js';
import {createRecurringAutomationOffer,isRecurringWorkPrompt,markRecurringAutomationOffer,readRecurringAutomationOffer,respondToRecurringAutomationOffer} from '../src/harness/recurringAutomationOffers.js';

const ORG='personal:recurring-offers';
let owner,member,root,source,who;
beforeEach(async()=>{
 await env.DB.exec(schemaSql.replace(/\n/g,' '));
 for(const [id,login,role] of [['9401','owner','admin'],['9402','member','member']]){
  await upsertUser(env.DB,{githubId:id,login,name:login});
  await upsertMembership(env.DB,ORG,id,role);
 }
 owner=await createSession(env.DB,'9401','test');member=await createSession(env.DB,'9402','test');
 await upsertBusiness(env.DB,ORG,{name:'Ops',createdBy:'9401'});
 await setMode(env.DB,ORG,'harness','9401');
 who={session:{github_id:'9402'},user:{login:'member',name:'Member',locale:'en'}};
 root=await postMessage(env.DB,{orgId:ORG,key:'b:ops',authorLogin:'member',body:'Please summarize open approvals every Monday.'});
 source=root.row;
});

test('message stores the offer pointer out of band from the readable body',async()=>{
 const posted=await postMessage(env.DB,{orgId:ORG,key:'b:ops',authorLogin:'agent:helper',kind:'agent',parentId:source.id,body:'Would you like an Automation?',automationOfferId:'12345678-1234-1234-1234-123456789abc'});
 expect(posted.row.body).not.toContain('12345678-1234-1234-1234-123456789abc');
 expect(posted.row.automation_offer_id).toBe('12345678-1234-1234-1234-123456789abc');
});

test('recognizes explicit recurring actions and ignores schedule words without work',()=>{
 expect(isRecurringWorkPrompt('Every Monday summarize open approvals')).toBe(true);
 expect(isRecurringWorkPrompt('毎週月曜に未決の承認をまとめてください')).toBe(true);
 expect(isRecurringWorkPrompt('What does weekly mean?')).toBe(false);
 expect(isRecurringWorkPrompt('Do this tomorrow')).toBe(false);
});

test('one room offer is created once per recurring cue and survives decline without being offered again',async()=>{
 const input={orgId:ORG,userId:'9402',login:'member',channel:'b:ops',threadId:source.id,sourceMessageId:source.id,prompt:source.body};
 const first=await createRecurringAutomationOffer(env.DB,input);
 expect(first?.id).toMatch(/^[0-9a-f-]{36}$/);
 expect(first).toEqual({id:first.id});
 expect(await createRecurringAutomationOffer(env.DB,{...input,prompt:'please SUMMARIZE open approvals every monday.'})).toBeNull();
 expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflows WHERE org_id=?1').bind(ORG).first('n')).toBe(0);
 expect(await markRecurringAutomationOffer(env.DB,{orgId:ORG,userId:'9402',id:first.id,state:'declined'})).toBe(true);
 expect((await readRecurringAutomationOffer(env.DB,{orgId:ORG,id:first.id})).state).toBe('declined');
 expect(await createRecurringAutomationOffer(env.DB,input)).toBeNull();
 const separate=await createRecurringAutomationOffer(env.DB,{...input,userId:'9401',login:'owner'});
 expect(separate?.id).toBeTruthy();
});

test('acceptance creates and enables a workflow only after the member accepts, without starting a run',async()=>{
 const made=await createRecurringAutomationOffer(env.DB,{orgId:ORG,userId:'9402',login:'member',channel:'b:ops',threadId:source.id,sourceMessageId:source.id,prompt:source.body});
 let generations=0;
 const generate=async(_env,_request,org,caller,input,options)=>{
  generations++;
  expect(caller.session.github_id).toBe('9402');
  expect(input.prompt).toBe(source.body);
  expect(options.enableAfterConsent).toBe(true);
  const result=await createWorkflow(env.DB,org,{name:'Weekly approvals',trigger:{type:'schedule',cadence:'weekly',weekday:1,hour:9,minute:0,timezone:'UTC'},steps:[{type:'post',channel:'b:ops',text:'Weekly approvals'}],enabled:options.enableAfterConsent},'9402',{source:options.sourceOverride});
  return result;
 };
 // Merely presenting the offer does not call the generation path.
 expect(generations).toBe(0);
 const accepted=await respondToRecurringAutomationOffer(env,new Request('https://example.test'),ORG,who,{id:made.id,action:'accept',timezone:'UTC'},{generate});
 expect(generations).toBe(1);
 expect(accepted).toMatchObject({offer:{state:'created'},workflow:{enabled:true}});
 const replay=await respondToRecurringAutomationOffer(env,new Request('https://example.test'),ORG,who,{id:made.id,action:'accept',timezone:'UTC'},{generate});
 expect(replay).toMatchObject({replay:true,offer:{state:'created'}});
 expect(generations).toBe(1);
 expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM hx_workflow_runs WHERE org_id=?1').bind(ORG).first('n')).toBe(0);
 expect((await readRecurringAutomationOffer(env.DB,{orgId:ORG,id:made.id})).workflow_id).toBe(accepted.workflow.id);
});

test('declining never generates work and an actor without room access cannot accept',async()=>{
 const made=await createRecurringAutomationOffer(env.DB,{orgId:ORG,userId:'9402',login:'member',channel:'b:ops',threadId:source.id,sourceMessageId:source.id,prompt:source.body});
 let generations=0;
 const generate=async()=>{generations++;throw new Error('must not generate')};
 const denied=await respondToRecurringAutomationOffer(env,new Request('https://example.test'),ORG,{session:{github_id:'9999'}},{id:made.id,action:'accept'},{generate});
 expect(denied).toMatchObject({status:404});
 const declined=await respondToRecurringAutomationOffer(env,new Request('https://example.test'),ORG,who,{id:made.id,action:'decline'},{generate});
 const declineReplay=await respondToRecurringAutomationOffer(env,new Request('https://example.test'),ORG,who,{id:made.id,action:'decline'},{generate});
 expect(declined).toMatchObject({offer:{state:'declined'}});
 expect(declineReplay).toMatchObject({replay:true,offer:{state:'declined'}});
 expect(generations).toBe(0);
});
