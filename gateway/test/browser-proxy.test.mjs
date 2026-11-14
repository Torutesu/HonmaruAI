import {test} from 'node:test';
import assert from 'node:assert/strict';
import {EventEmitter} from 'node:events';
import http from 'node:http';
import net from 'node:net';
import {once} from 'node:events';
import {Writable} from 'node:stream';
import {createBrowserEgressProxy,isPublicAddress,resolvePublicAddress} from '../browser-proxy.mjs';

test('public-address check rejects local, shared, documentation and reserved ranges',()=>{
 for(const address of ['0.0.0.0','10.1.2.3','100.64.0.1','127.0.0.1','169.254.169.254','172.31.1.1','192.0.2.1','192.168.1.1','198.18.0.1','203.0.113.9','224.0.0.1','240.0.0.1','::','::1','::ffff:8.8.8.8','fc00::1','fe80::1','ff02::1','2001:db8::1','2001:10::1','2001:20::1','2002:7f00:1::1','5f00::1']) {
   assert.equal(isPublicAddress(address),false,address);
 }
 for(const address of ['1.1.1.1','8.8.8.8','192.31.196.1','192.52.193.1','192.175.48.1','2606:4700:4700::1111','2001:4860:4860::8888']) assert.equal(isPublicAddress(address),true,address);
});

test('plain WebSocket upgrades to a host resolving to a private address fail closed',async t=>{
 let connectCalls=0;
 const proxy=createBrowserEgressProxy({lookup:async()=>[{address:'10.0.0.8',family:4}],connect:()=>{connectCalls++;throw Error('must not connect')}});
 const address=await proxy.listen();t.after(()=>proxy.close());
 const client=net.connect(address.port,'127.0.0.1');await once(client,'connect');
 client.write('GET ws://internal.example.test/socket HTTP/1.1\r\nHost: internal.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\n\r\n');
 let response='';client.on('data',chunk=>{response+=chunk.toString()});
 await new Promise(resolve=>client.once('close',resolve));
 assert.match(response,/403 Forbidden/);assert.equal(connectCalls,0);
});

test('plain WebSocket upgrade connects to the validated IP and forwards only the target handshake',async t=>{
 let connectOptions;let received='';
 const upstream=http.createServer();
 upstream.on('upgrade',(request,socket)=>{
   received=`${request.method} ${request.url} ${request.headers.host} ${request.headers.connection} ${request.headers.upgrade}`;
   socket.end('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n');
 });
 await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));t.after(()=>upstream.close());
 const proxy=createBrowserEgressProxy({lookup:async()=>[{address:'93.184.216.34',family:4}],connect:options=>{
   connectOptions=options;return net.connect(upstream.address().port,'127.0.0.1');
 }});
 const address=await proxy.listen();t.after(()=>proxy.close());
 const client=net.connect(address.port,'127.0.0.1');await once(client,'connect');
 client.write('GET ws://docs.example.test/socket?q=1 HTTP/1.1\r\nHost: docs.example.test\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\nSec-WebSocket-Version: 13\r\nProxy-Authorization: secret\r\n\r\n');
 const [response]=await once(client,'data');
 assert.match(response.toString(),/101 Switching Protocols/);
 assert.deepEqual(connectOptions,{host:'93.184.216.34',family:4,port:80,timeout:15000});
 assert.equal(received,'GET /socket?q=1 docs.example.test Upgrade websocket');
 client.destroy();
});

test('DNS answers containing any private or special address fail closed',async()=>{
 await assert.rejects(resolvePublicAddress('docs.example.test',async()=>[
   {address:'93.184.216.34',family:4},{address:'169.254.169.254',family:4},
 ]),/did not resolve safely/);
 await assert.rejects(resolvePublicAddress('docs.example.test',async()=>[]),/did not resolve safely/);
});

test('DNS resolution has a finite deadline',async()=>{
 await assert.rejects(resolvePublicAddress('docs.example.test',()=>new Promise(()=>{}),5),/timed out/);
});

test('public host is resolved once and returned as the pinned address',async()=>{
 const result=await resolvePublicAddress('docs.example.test',async(host,options)=>{
   assert.equal(host,'docs.example.test');assert.equal(options.all,true);
   return [{address:'2606:4700:4700::1111',family:6},{address:'93.184.216.34',family:4}];
 });
 assert.deepEqual(result,{address:'93.184.216.34',family:4});
});

test('HTTP proxy pins the DNS address, preserves the origin host, and forwards the response',async t=>{
 let requestOptions;
 const proxy=createBrowserEgressProxy({
   lookup:async()=>[{address:'93.184.216.34',family:4}],
   request:options=>{
     requestOptions=options;
     return new Writable({write(_chunk,_encoding,callback){callback();},final(callback){
       this.emit('response',{statusCode:200,headers:{'content-type':'text/plain'},pipe(destination){destination.end('safe response');}});
       callback();
     }});
   },
 });
 const address=await proxy.listen();t.after(()=>proxy.close());
 const client=net.connect(address.port,'127.0.0.1');await once(client,'connect');
 client.write('GET http://docs.example.test/path?q=1 HTTP/1.1\r\nHost: docs.example.test\r\n\r\n');
 let response='';await new Promise(resolve=>client.on('data',chunk=>{response+=chunk.toString();if(response.includes('safe response')){client.destroy();resolve();}}));
 assert.equal(requestOptions.hostname,'93.184.216.34');
 assert.equal(requestOptions.path,'/path?q=1');
 assert.equal(requestOptions.headers.host,'docs.example.test');
 assert.match(response,/200 OK/);assert.match(response,/safe response/);
});

test('CONNECT to a blocked destination is rejected before opening a socket',async t=>{
 let connectCalls=0;
 const proxy=createBrowserEgressProxy({lookup:async()=>[{address:'127.0.0.1',family:4}],connect:()=>{connectCalls++;throw Error('must not connect')}});
 const address=await proxy.listen();t.after(()=>proxy.close());
 const client=net.connect(address.port,'127.0.0.1');await once(client,'connect');
 client.write('CONNECT internal.example.test:443 HTTP/1.1\r\nHost: internal.example.test:443\r\n\r\n');
 let response='';client.on('data',chunk=>{response+=chunk.toString()});
 await new Promise(resolve=>client.once('close',resolve));
 assert.match(response,/403 Forbidden/);assert.equal(connectCalls,0);
});

test('CONNECT cannot reach arbitrary cleartext service ports',async t=>{
 let connectCalls=0;
 const proxy=createBrowserEgressProxy({lookup:async()=>[{address:'93.184.216.34',family:4}],connect:()=>{connectCalls++;throw Error('must not connect')}});
 const address=await proxy.listen();t.after(()=>proxy.close());
 const client=net.connect(address.port,'127.0.0.1');await once(client,'connect');
 client.write('CONNECT docs.example.test:80 HTTP/1.1\r\nHost: docs.example.test:80\r\n\r\n');
 let response='';client.on('data',chunk=>{response+=chunk.toString()});
 await new Promise(resolve=>client.once('close',resolve));
 assert.match(response,/403 Forbidden/);assert.equal(connectCalls,0);
});

test('CONNECT opens the exact validated public IP and never re-resolves by hostname',async t=>{
 let connectOptions;
 const proxy=createBrowserEgressProxy({
   lookup:async()=>[{address:'93.184.216.34',family:4}],
   connect:options=>{connectOptions=options;const socket=new EventEmitter();socket.destroy=()=>{};process.nextTick(()=>socket.emit('error',Error('synthetic socket end')));return socket;},
 });
 const address=await proxy.listen();t.after(()=>proxy.close());
 const client=net.connect(address.port,'127.0.0.1');await once(client,'connect');
 client.write('CONNECT docs.example.test:443 HTTP/1.1\r\nHost: docs.example.test:443\r\n\r\n');
 let response='';client.on('data',chunk=>{response+=chunk.toString()});
 await new Promise(resolve=>client.once('close',resolve));
 assert.deepEqual(connectOptions,{host:'93.184.216.34',family:4,port:443,timeout:15000});
 assert.match(response,/502 Bad Gateway/);assert.doesNotMatch(response,/200 Connection Established/);
});
