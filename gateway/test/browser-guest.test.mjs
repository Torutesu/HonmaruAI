import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import {createBrowserCommandHandler,createCancellablePageRunner} from '../browser-image/command-server.mjs';

function fakeContext(){
 const pages=[];let pageListener=()=>{};
 const context={profileMarker:'same-persistent-profile',pages:()=>[...pages],on:(event,listener)=>{if(event==='page')pageListener=listener;},async newPage(){
  const page=new EventEmitter();page.url='about:blank';page.closed=false;
  page.close=async()=>{if(page.closed)return;page.closed=true;pages.splice(pages.indexOf(page),1);page.emit('close');};
  pages.push(page);pageListener(page);return page;
 }};
 return context;
}

test('revoking during a browser action closes only its page and the next authorized action gets a fresh page',async()=>{
 const context=fakeContext(),first=await context.newPage(),profile=context.profileMarker;
 const runner=createCancellablePageRunner({context,initialPage:first,run:async(page,action)=>{
  if(action==='delayed-navigation')await new Promise((resolve,reject)=>page.once('close',()=>reject(new Error('page closed'))));
  return {url:page.url};
 }});
 const controller=new AbortController();
 const active=runner('delayed-navigation',{signal:controller.signal});
 await new Promise(resolve=>setImmediate(resolve));
 controller.abort();
 await assert.rejects(active,/page closed/);
 assert.equal(first.closed,true);
 assert.equal(context.profileMarker,profile);
 assert.equal(context.pages().length,1);
 assert.notEqual(context.pages()[0],first);
  assert.deepEqual(await runner('resume'),{url:'about:blank'});
 assert.equal(context.profileMarker,profile);
});

test('disconnect aborts the active command and drops a disconnected command queued behind it',async()=>{
 const calls=[];let signalFirstStarted;
 const firstStarted=new Promise(resolve=>{signalFirstStarted=resolve;});
 const host='127.0.0.1:37654';
 const handler=createBrowserCommandHandler({token:'test-token',host,run:async(action,{signal})=>{
  calls.push(action.type);
  if(action.type==='active'){
   signalFirstStarted();
   await new Promise(resolve=>signal.addEventListener('abort',resolve,{once:true}));
   return {cancelled:true};
  }
  return {action:action.type};
 }});
 const makeRequest=type=>{
  const request=new EventEmitter();request.method='POST';request.url='/command';request.headers={host,authorization:'Bearer test-token'};request.socket=new EventEmitter();request.setEncoding=()=>{};
  queueMicrotask(()=>{request.emit('data',JSON.stringify({type}));request.emit('end');});
  return request;
 };
 const makeResponse=()=>{
  const response=new EventEmitter();response.writableEnded=false;response.destroyed=false;
  response.setHeader=()=>{};response.writeHead=status=>{response.statusCode=status;return response;};
  response.end=body=>{response.body=body;response.writableEnded=true;return response;};
  return response;
 };
 const activeResponse=makeResponse(),queuedResponse=makeResponse();
 const active=handler(makeRequest('active'),activeResponse);
 await firstStarted;
 const queued=handler(makeRequest('cancelled-while-queued'),queuedResponse);
 await new Promise(resolve=>setImmediate(resolve));
 queuedResponse.destroyed=true;queuedResponse.emit('close');
 activeResponse.destroyed=true;activeResponse.emit('close');
 await Promise.all([active,queued]);
 const resumedResponse=makeResponse();
 await handler(makeRequest('resumed'),resumedResponse);
 assert.equal(resumedResponse.statusCode,200);
 assert.deepEqual(JSON.parse(resumedResponse.body),{action:'resumed'});
 assert.deepEqual(calls,['active','resumed']);
});
