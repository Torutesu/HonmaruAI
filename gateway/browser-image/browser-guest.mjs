import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';

const PORT=37654;
const BODY_LIMIT=16*1024;
const token=(await readFile('/run/honmaru/control-token','utf8')).trim();
const context=await chromium.launchPersistentContext('/data',{
  headless:true,
  chromiumSandbox:true,
  acceptDownloads:false,
  serviceWorkers:'allow',
  proxy:{server:'http://127.0.0.1:3128'},
  viewport:{width:1280,height:800},
  args:[
    '--proxy-bypass-list=<-loopback>',
    '--disable-quic',
    '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
  ],
});
let page=context.pages()[0]||await context.newPage();
context.on('page',next=>{page=next;});
let active=Promise.resolve();

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
  });
}

async function run(action) {
  switch(action?.type){
    case 'navigate': {
      const url=new URL(action.url);
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid browser URL.');
      let response;
      for(let attempt=0;attempt<2;attempt++){
        try { response=await page.goto(url.href,{waitUntil:'domcontentloaded',timeout:20000});break; }
        catch(error){
          if(attempt!==0||!String(error?.message||'').includes('net::ERR_NETWORK_CHANGED'))throw error;
          await new Promise(resolve=>setTimeout(resolve,150));
        }
      }
      // Some sites attach their stylesheets and fonts after DOMContentLoaded.
      // Give the page a short, bounded chance to finish loading before the
      // next screenshot, without making slow or long-polling pages block the
      // browser session indefinitely.
      await page.waitForLoadState('load',{timeout:5000}).catch(()=>{});
      return {url:page.url(),title:await page.title(),status:response?.status()??null};
    }
    case 'click': await page.mouse.click(action.x,action.y);return {url:page.url()};
    case 'type': await page.keyboard.insertText(action.text);return {url:page.url()};
    case 'press': await page.keyboard.press(action.key);return {url:page.url()};
    case 'scroll': await page.mouse.move(action.x,action.y);await page.mouse.wheel(action.deltaX,action.deltaY);return {url:page.url()};
    case 'screenshot': {
      const image=await page.screenshot({type:'jpeg',quality:65,animations:'disabled',fullPage:false,timeout:7000});
      if(image.length>2*1024*1024)throw new Error('Browser screenshot is too large.');
      if(action.thumbnail===true){
        const imageBase64=image.toString('base64');
        const thumbnail=await page.evaluate(async({source,maxChars})=>{
          const image=new Image();image.src=`data:image/jpeg;base64,${source}`;await image.decode();
          const canvas=document.createElement('canvas');const context=canvas.getContext('2d');
          if(!context)return null;
          for(const maxWidth of [640,560,480,400,320]){
            const scale=Math.min(maxWidth/image.naturalWidth,400/image.naturalHeight,1);
            canvas.width=Math.max(1,Math.round(image.naturalWidth*scale));
            canvas.height=Math.max(1,Math.round(image.naturalHeight*scale));
            context.drawImage(image,0,0,canvas.width,canvas.height);
            for(const quality of [0.72,0.62,0.52,0.42,0.32]){
              const data=canvas.toDataURL('image/jpeg',quality).slice('data:image/jpeg;base64,'.length);
              if(data.length<=maxChars)return data;
            }
          }
          return null;
        },{source:imageBase64,maxChars:40_000});
        if(typeof thumbnail!=='string')throw new Error('Browser screenshot thumbnail exceeds the transfer limit.');
        return {url:page.url(),image:thumbnail};
      }
      return {url:page.url(),image:image.toString('base64')};
    }
    case 'visible_text': return {url:page.url(),title:await page.title(),text:(await page.locator('body').innerText({timeout:7000})).slice(0,16000)};
    default: throw new Error('Unsupported browser action.');
  }
}

const server=createServer(async(request,response)=>{
  response.setHeader('cache-control','no-store');
  if(request.method!=='POST'||request.url!=='/command'||request.headers.host!==`127.0.0.1:${PORT}`||request.headers.origin||request.headers.authorization!==`Bearer ${token}`){
    response.writeHead(404).end();return;
  }
  let input;
  try { input=await readJson(request); }
  catch { response.writeHead(400).end();return; }
  let result;
  const operation=active.then(()=>run(input));
  active=operation.catch(()=>{});
  try { result=await operation; }
  catch(error) {
    const message=String(error?.message||'');
    const code=error?.name==='TimeoutError'?'timeout':/net::ERR_/.test(message)?'network':'action_failed';
    const detail=message.replace(/https?:\/\/[^\s)]+/g,'[url]').replace(/Bearer\s+\S+/gi,'Bearer [redacted]').slice(0,180);
    response.writeHead(422,{'content-type':'application/json'}).end(JSON.stringify({error:'Browser action failed.',code,detail}));return;
  }
  const output=JSON.stringify(result);
  if(Buffer.byteLength(output)>3*1024*1024){response.writeHead(413).end();return;}
  response.writeHead(200,{'content-type':'application/json'}).end(output);
});
server.listen(PORT,'127.0.0.1');
const shutdown=async()=>{server.close();await context.close();process.exit(0);};
process.once('SIGTERM',shutdown);
process.once('SIGINT',shutdown);
