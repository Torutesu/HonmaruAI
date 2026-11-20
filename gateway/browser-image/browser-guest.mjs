import {createServer} from 'node:http';
import {readFile} from 'node:fs/promises';
import {chromium} from 'playwright';
import {createBrowserCommandHandler,createCancellablePageRunner} from './command-server.mjs';

const PORT=37654;
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

async function run(action,targetPage=page) {
  switch(action?.type){
    case 'navigate': {
      const url=new URL(action.url);
      if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid browser URL.');
      let response;
      for(let attempt=0;attempt<2;attempt++){
        try { response=await targetPage.goto(url.href,{waitUntil:'domcontentloaded',timeout:20000});break; }
        catch(error){
          if(attempt!==0||!String(error?.message||'').includes('net::ERR_NETWORK_CHANGED'))throw error;
          await new Promise(resolve=>setTimeout(resolve,150));
        }
      }
      // Some sites attach their stylesheets and fonts after DOMContentLoaded.
      // Give the page a short, bounded chance to finish loading before the
      // next screenshot, without making slow or long-polling pages block the
      // browser session indefinitely.
      await targetPage.waitForLoadState('load',{timeout:5000}).catch(()=>{});
      return {url:targetPage.url(),title:await targetPage.title(),status:response?.status()??null};
    }
    case 'click': await targetPage.mouse.click(action.x,action.y);return {url:targetPage.url()};
    case 'type': await targetPage.keyboard.insertText(action.text);return {url:targetPage.url()};
    case 'press': await targetPage.keyboard.press(action.key);return {url:targetPage.url()};
    case 'scroll': await targetPage.mouse.move(action.x,action.y);await targetPage.mouse.wheel(action.deltaX,action.deltaY);return {url:targetPage.url()};
    case 'screenshot': {
      const image=await targetPage.screenshot({type:'jpeg',quality:65,animations:'disabled',fullPage:false,timeout:7000});
      if(image.length>2*1024*1024)throw new Error('Browser screenshot is too large.');
      if(action.thumbnail===true){
        const imageBase64=image.toString('base64');
        const thumbnail=await targetPage.evaluate(async({source,maxChars})=>{
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
        return {url:targetPage.url(),image:thumbnail};
      }
      return {url:targetPage.url(),image:image.toString('base64')};
    }
    case 'visible_text': return {url:targetPage.url(),title:await targetPage.title(),text:(await targetPage.locator('body').innerText({timeout:7000})).slice(0,16000)};
    default: throw new Error('Unsupported browser action.');
  }
}

const runAuthorizedAction=createCancellablePageRunner({context,initialPage:page,run:(targetPage,action)=>run(action,targetPage)});
const server=createServer(createBrowserCommandHandler({token,run:runAuthorizedAction}));
server.listen(PORT,'127.0.0.1');
const shutdown=async()=>{server.close();await context.close();process.exit(0);};
process.once('SIGTERM',shutdown);
process.once('SIGINT',shutdown);
