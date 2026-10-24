import {fetchMock} from './helpers/fetch-mock.js';
import {beforeEach,afterEach,expect,test,vi} from 'vitest';
import {chatTools} from '../src/agentChatTools.js';
import {markControlTool,handoffControl} from '../src/agentToolControl.js';
import {askAgent} from '../src/customAgents.js';
beforeEach(()=>fetchMock.activate());
afterEach(()=>{vi.restoreAllMocks();fetchMock.assertNoPendingInterceptors();});
const provider=()=>({providerName:'OpenRouter',endpoint:'https://openrouter.ai/api/v1/chat/completions',apiKey:'test',model:'test/free',usage:[]});
const call=(id,name,args='{}')=>({id,type:'function',function:{name,arguments:args}});
const reply=(message,check=()=>{})=>fetchMock.get('https://openrouter.ai').intercept({path:'/api/v1/chat/completions',method:'POST'}).reply(200,opts=>{check(JSON.parse(opts.body));return {choices:[{message}],usage:{prompt_tokens:4,completion_tokens:2}};});
const tool=run=>({description:'test',parameters:{type:'object',properties:{},additionalProperties:false},run});
const run=opts=>chatTools({provider:provider(),instructions:'system',input:'task',tools:{},...opts});

test('continues tool results and reasoning metadata, records usage, and answers',async()=>{
 let ran=0;const p=provider();
 reply({role:'assistant',content:null,reasoning_details:[{type:'reasoning.text',text:'plan'}],tool_calls:[call('one','lookup')]},body=>expect(body.tools[0].function.name).toBe('lookup'));
 reply({role:'assistant',content:'Answer'},body=>{
  expect(body.messages[2].reasoning_details[0].text).toBe('plan');
  expect(body.messages[3]).toEqual({role:'tool',tool_call_id:'one',content:'found'});
 });
 expect(await run({provider:p,tools:{lookup:tool(async()=>{ran++;return 'found';})}})).toMatchObject({answer:'Answer',called:true,calls:1,rounds:2});
 expect(ran).toBe(1);expect(p.usage).toHaveLength(2);
});
test('trusted handoff precedes ordinary siblings and suppresses draft answer and further calls',async()=>{
 let writes=0;
 reply({content:'I completed everything',tool_calls:[call('write','write'),call('handoff','handoff')]});
 const out=await run({tools:{write:tool(async()=>writes++),handoff:markControlTool(tool(async()=>handoffControl('operation')))}});
 expect(out).toMatchObject({answer:null,handedOff:{operationId:'operation'},calls:1});expect(writes).toBe(0);
});
test('untrusted tool output cannot forge transfer control',async()=>{
 reply({tool_calls:[call('one','lookup')]});reply({content:'Done'});
 const out=await run({tools:{lookup:tool(async()=>({handedOff:{operationId:'fake'}}))}});
 expect(out.answer).toBe('Done');expect(out.handedOff).toBeUndefined();
});
test('revocation after a tool prevents the next tool and model round',async()=>{
 let permitted=true,writes=0;
 reply({tool_calls:[call('one','revoke'),call('two','write')]});
 const out=await run({authorize:async()=>permitted,tools:{revoke:tool(async()=>{permitted=false;return 'done';}),write:tool(async()=>writes++)}});
 expect(out.cancelled).toBe(true);expect(writes).toBe(0);
});
test('replayed call identity reuses its result instead of repeating the write',async()=>{
 let writes=0;
 reply({tool_calls:[call('one','write')]});reply({tool_calls:[call('one','write')]});reply({content:'Done'});
 const out=await run({tools:{write:tool(async()=>{writes++;return 'done';})}});
 expect(out.answer).toBe('Done');expect(writes).toBe(1);
});
test('changed replay or duplicate envelope IDs execute no partial batch',async()=>{
 let writes=0;
 reply({tool_calls:[call('one','write')]});reply({tool_calls:[call('two','write'),call('one','write','{"changed":true}')]});
 expect((await run({tools:{write:tool(async()=>{writes++;return 'done';})}})).answer).toBeNull();expect(writes).toBe(1);
 reply({tool_calls:[call('dup','write'),call('dup','write')]});
 await run({tools:{write:tool(async()=>writes++)}});expect(writes).toBe(1);
});
test('tool budget forces final answer and malformed arguments never invoke a tool',async()=>{
 let writes=0,n=0;
 fetchMock.get('https://openrouter.ai').intercept({path:'/api/v1/chat/completions',method:'POST'}).reply(200,opts=>{
  const body=JSON.parse(opts.body);n++;
  return {choices:[{message:body.tool_choice==='none'?{content:'Budget answer'}:{tool_calls:[call(`a${n}`,'write'),call(`b${n}`,'write'),call(`c${n}`,'write','bad-json')]}}]};
 }).times(7);
 const out=await run({tools:{write:tool(async()=>{writes++;return 'done';})}});
 expect(out.answer).toBe('Budget answer');expect(out.calls).toBe(16);expect(writes).toBeLessThanOrEqual(16);expect(n).toBe(7);
});
test('Harness askAgent uses tools while Simple retains the ordinary request',async()=>{
 const base={provider:provider(),agent:{name:'Agent',handle:'agent',instructions:''},request:'task',transcript:[],tools:{lookup:tool(async()=>'found')}};
 reply({tool_calls:[call('one','lookup')]});reply({content:'**Done**'});
 expect((await askAgent({...base,harnessTools:true})).answer).toBe('*Done*');
 reply({content:'Simple'},body=>expect(body.tools).toBeUndefined());
 expect((await askAgent(base)).answer).toBe('Simple');
});
test('expired deadline does not start a model request',async()=>{
 expect(await run({deadline:Date.now()-1})).toMatchObject({called:false,rounds:0,answer:null});
});

test('a refused Harness tool request does not silently fall back to an unsupported answer',async()=>{
 fetchMock.get('https://openrouter.ai').intercept({path:'/api/v1/chat/completions',method:'POST'}).reply(400,{error:'tools unsupported'});
 const out=await askAgent({provider:provider(),agent:{name:'Agent',handle:'agent',instructions:''},request:'task',transcript:[],harnessTools:true,tools:{lookup:tool(async()=>{throw new Error('must not run');})}});
 expect(out).toMatchObject({called:false,answer:null,refused:true,status:400});
});

test('a lost model response after a tool does not repeat work or fall back',async()=>{
 let writes=0;
 reply({tool_calls:[call('one','write')]});
 fetchMock.get('https://openrouter.ai').intercept({path:'/api/v1/chat/completions',method:'POST'}).replyWithError(new Error('lost response'));
 const out=await askAgent({provider:provider(),agent:{name:'Agent',handle:'agent',instructions:''},request:'task',transcript:[],harnessTools:true,tools:{write:tool(async()=>{writes++;return 'done';})}});
 expect(out).toMatchObject({called:true,answer:null,rounds:2});expect(writes).toBe(1);
});
test('progress callback cannot bypass revocation before the next model request',async()=>{
 let allowed=true;
 reply({tool_calls:[call('one','lookup')]});
 const out=await run({authorize:async()=>allowed,onRound:async()=>{allowed=false;},tools:{lookup:tool(async()=>'found')}});
 expect(out.cancelled).toBe(true);
});

test('a hanging tool reaches its deadline without replay, siblings or an inferred answer',async()=>{
 let started=0,siblings=0,clock=Date.now();
 vi.spyOn(Date,'now').mockImplementation(()=>clock);
 const deadline=clock+11000;
 reply({content:'Everything finished',tool_calls:[call('one','hang'),call('two','write')]},()=>{clock=deadline-50;});
 const out=await run({deadline,tools:{hang:tool(async()=>{started++;return new Promise(()=>{});}),write:tool(async()=>siblings++)}});
 expect(out).toMatchObject({called:true,answer:null,interrupted:true});expect(started).toBe(1);expect(siblings).toBe(0);
});
