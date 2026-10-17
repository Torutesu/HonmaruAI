// Two sandboxes: the outer frame's frame-src 'none' also prevents the generated
// inner document navigating to an external URL to leak its read-only snapshot.
export function customRunner() {
  const html = `<!doctype html><meta name="color-scheme" content="light dark"><style>html,body,iframe{margin:0;width:100%;height:100%;border:0}iframe{display:block}</style><iframe sandbox="allow-scripts" title="Custom app output"></iframe><script>
const child=document.querySelector('iframe');
addEventListener('message', e=>{
 if(e.source===parent&&e.data?.type==='honmaru:init'&&typeof e.data.html==='string'&&e.data.html.length<=120000){
 child.style.colorScheme=e.data.theme==='dark'?'dark':e.data.theme==='light'?'light':'light dark';
 const bridge='<script>const call=(operation,args)=>new Promise((resolve,reject)=>{const id=crypto.randomUUID();const listener=e=>{if(e.source===parent&&e.data?.type==="honmaru:result"&&e.data.id===id){removeEventListener("message",listener);e.data.error?reject(new Error(e.data.error)):resolve(e.data.value)}};addEventListener("message",listener);parent.postMessage({type:"honmaru:request",id,operation,args},"*")});window.honmaru={read:()=>call("read",{}),create:(values,entity="primary")=>call("create",{values,entity}),update:(id,values,entity="primary")=>call("update",{id,values,entity}),remove:(id,entity="primary")=>call("remove",{id,entity}),entity:entity=>call("entity",{entity}),run:(name,input,gatewayId)=>call("run",{name,input,gatewayId}),job:id=>call("job",{id}),connect:(name,body)=>call("connect",{name,body})};<'+'/script>';
 child.srcdoc=bridge+e.data.html;
 } else if(e.source===child.contentWindow&&e.data?.type==='honmaru:request'&&typeof e.data.id==='string'&&e.data.id.length<=80){parent.postMessage({type:'honmaru:request',id:e.data.id,operation:e.data.operation,args:e.data.args},'*')}
 else if(e.source===parent&&e.data?.type==='honmaru:result'){child.contentWindow.postMessage(e.data,'*')}
});
parent.postMessage({type:'honmaru:ready'},'*');
</script>`;
  return new Response(html, { headers: {
    'content-type': 'text/html; charset=utf-8',
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox allow-scripts",
    'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=()',
    'cache-control': 'public, max-age=300',
  }});
}
