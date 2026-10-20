import { beforeEach, afterEach, expect, test, vi } from 'vitest';
import { fetchMock } from './helpers/fetch-mock.js';
import { completeWithTools } from '../src/harness/modelToolLoop.js';
beforeEach(() => fetchMock.activate());
afterEach(() => fetchMock.assertNoPendingInterceptors());
const options = () => ({provider:{endpoint:'https://model.example/chat',apiKey:'test',model:'test'},system:'Catalog',fallbackSystem:'Full procedure',user:'Do work',maxTokens:100,json:false,timeoutMs:30000,onUsage:vi.fn()});
const read = run => ({read_installed_skill:{description:'Read skill',parameters:{type:'object'},run}});
const call = id => ({id,type:'function',function:{name:'read_installed_skill',arguments:'{"skill_id":"one"}'}});
test('scheduled completion reads tools and meters every successful round',async()=>{
 const opts=options(), run=vi.fn(async()=> 'Complete procedure'), bodies=[];
 fetchMock.get('https://model.example').intercept({path:'/chat',method:'POST'}).reply(200,o=>{bodies.push(JSON.parse(o.body));return {choices:[{message:{tool_calls:[call('first')]}}]}});
 fetchMock.get('https://model.example').intercept({path:'/chat',method:'POST'}).reply(200,o=>{bodies.push(JSON.parse(o.body));return {choices:[{message:{content:'Done'}}]}});
 expect(await completeWithTools({...opts,tools:read(run)})).toBe('Done');
 expect(run).toHaveBeenCalledExactlyOnceWith({skill_id:'one'});
 expect(bodies[0].messages[0].content).toBe('Catalog');
 expect(bodies[1].messages.at(-1)).toMatchObject({role:'tool',content:'Complete procedure'});
 expect(opts.onUsage).toHaveBeenCalledTimes(2);
});
test('tool refusal falls back to complete instructions without tools',async()=>{
 const opts=options();let fallback;
 fetchMock.get('https://model.example').intercept({path:'/chat',method:'POST'}).reply(400,'Unsupported tools');
 fetchMock.get('https://model.example').intercept({path:'/chat',method:'POST'}).reply(200,o=>{fallback=JSON.parse(o.body);return {choices:[{message:{content:'Fallback'}}]}});
 expect(await completeWithTools({...opts,tools:read(vi.fn())})).toBe('Fallback');
 expect(fallback.tools).toBeUndefined();expect(fallback.messages[0].content).toBe('Full procedure');
 expect(opts.onUsage).toHaveBeenCalledTimes(1);
});
test('tool rounds are bounded and final completion cannot execute another call',async()=>{
 const opts=options(),run=vi.fn(async()=> 'Procedure');let rounds=0;
 fetchMock.get('https://model.example').intercept({path:'/chat',method:'POST'}).reply(200,o=>{
   rounds++;const body=JSON.parse(o.body);
   return {choices:[{message:body.tool_choice==='none'?{content:'Final'}:{tool_calls:[call(`call-${rounds}`)]}}]};
 }).persist();
 expect(await completeWithTools({...opts,tools:read(run)})).toBe('Final');
 expect(rounds).toBe(4);expect(run).toHaveBeenCalledTimes(3);
});
