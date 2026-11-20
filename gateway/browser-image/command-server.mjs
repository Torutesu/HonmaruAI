const BODY_LIMIT=16*1024;

function readJson(request) {
  return new Promise((resolve,reject)=>{
    let body='';
    request.setEncoding('utf8');
    request.on('data',chunk=>{
      body+=chunk;
      if(Buffer.byteLength(body)>BODY_LIMIT){reject(new Error('Request is too large.'));request.destroy();}
    });
    request.on('end',()=>{
      try { resolve(JSON.parse(body)); } catch { reject(new Error('Invalid browser command.')); }
    });
    request.on('error',reject);
    request.on('aborted',()=>reject(new Error('Browser command was cancelled.')));
  });
}

export function createCancellablePageRunner({context,initialPage,run}) {
  let page=initialPage;
  context.on('page',next=>{page=next;});
  return async (action,{signal}={})=>{
    if(signal?.aborted)throw new Error('Browser action cancelled.');
    const target=page||context.pages().at(-1)||await context.newPage();
    let interrupted=false;
    const cancel=()=>{
      interrupted=true;
      if(page===target)page=null;
      void target.close({runBeforeUnload:false}).catch(()=>{});
    };
    signal?.addEventListener('abort',cancel,{once:true});
    try {
      if(signal?.aborted)cancel();
      if(interrupted)throw new Error('Browser action cancelled.');
      return await run(target,action,{signal});
    } finally {
      signal?.removeEventListener('abort',cancel);
      if(interrupted){
        const remaining=context.pages().filter(candidate=>candidate!==target);
        page=remaining.at(-1)||await context.newPage();
      }
    }
  };
}

export function createBrowserCommandHandler({token,run,host='127.0.0.1:37654'}) {
  let active=Promise.resolve();
  return async(request,response)=>{
    response.setHeader('cache-control','no-store');
    if(request.method!=='POST'||request.url!=='/command'||request.headers.host!==host||request.headers.origin||request.headers.authorization!==`Bearer ${token}`){
      response.writeHead(404).end();return;
    }
    let input;
    try { input=await readJson(request); }
    catch { if(!response.destroyed)response.writeHead(400).end();return; }
    const controller=new AbortController();
    const cancel=()=>{if(!response.writableEnded)controller.abort();};
    const onClose=()=>{if(!response.writableEnded)cancel();};
    const onSocketClose=()=>cancel();
    request.once('aborted',cancel);
    response.once('close',onClose);
    request.socket?.once('close',onSocketClose);
    const operation=active.then(()=>{
      if(controller.signal.aborted)throw new Error('Browser action cancelled.');
      return run(input,{signal:controller.signal});
    });
    active=operation.catch(()=>{});
    try {
      const result=await operation;
      if(controller.signal.aborted||response.destroyed)return;
      const output=JSON.stringify(result);
      if(Buffer.byteLength(output)>3*1024*1024){response.writeHead(413).end();return;}
      response.writeHead(200,{'content-type':'application/json'}).end(output);
    } catch(error) {
      if(controller.signal.aborted||response.destroyed)return;
      const message=String(error?.message||'');
      const code=error?.name==='TimeoutError'?'timeout':/net::ERR_/.test(message)?'network':'action_failed';
      const detail=message.replace(/https?:\/\/[^\s)]+/g,'[url]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,180);
      response.writeHead(422,{'content-type':'application/json'}).end(JSON.stringify({error:'Browser action failed.',code,detail}));
    } finally {
      request.off('aborted',cancel);
      response.off('close',onClose);
      request.socket?.off('close',onSocketClose);
    }
  };
}
