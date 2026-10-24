// Disposable local Worker fixture only. No real node or paid model is invoked.
export async function gatewayTypeScript({context,web,apiHost,shots}) {
 if(new URL(apiHost).hostname!=='127.0.0.1')throw Error('Gateway fixtures require the local test Worker')
 const page=await context.newPage();let previousMode,nodeId
 const call=(method,path,body)=>page.evaluate(async({method,path,body,apiHost})=>{
  const orgId=localStorage.getItem('orgId'),url=new URL(path,apiHost)
  if(method==='GET')url.searchParams.set('orgId',orgId)
  const r=await fetch(url,{method,headers:{'content-type':'application/json','x-session-token':localStorage.getItem('sessionToken')},body:method==='GET'?undefined:JSON.stringify({...body,orgId})})
  if(!r.ok)throw Error(`Gateway fixture ${method} ${path}: ${r.status}`)
  return r.json()
 },{method,path,body,apiHost})
 try {
  await page.goto(web,{waitUntil:'load'})
  await page.waitForFunction(()=>Boolean(localStorage.getItem('sessionToken')&&localStorage.getItem('orgId')))
  previousMode=(await call('GET','/orgs/mode')).mode
  await call('PUT','/orgs/mode',{mode:'harness'})
  const registered=await call('POST','/gateways',{name:`Local TypeScript fixture ${Date.now()}`});nodeId=registered.gateway.id
  await page.reload({waitUntil:'load'});await page.goto(`${web}#/gateways`,{waitUntil:'load'})
  await page.getByLabel(/^(Execution node|実行ノード)$/,{exact:true}).selectOption(nodeId)
  await page.getByLabel('JavaScript',{exact:true}).fill('return 17')
  await page.getByLabel(/^(Language|言語)$/,{exact:true}).selectOption('typescript')
  const code='export default async function(input: number): Promise<number> { return input * 2 }'
  await page.getByLabel('TypeScript',{exact:true}).fill(code)
  await page.getByLabel(/^(Language|言語)$/,{exact:true}).selectOption('javascript')
  if(await page.getByLabel('JavaScript',{exact:true}).inputValue()!=='return 17')throw Error('JavaScript draft was lost')
  await page.getByLabel(/^(Language|言語)$/,{exact:true}).selectOption('typescript')
  if(await page.getByLabel('TypeScript',{exact:true}).inputValue()!==code)throw Error('TypeScript draft was lost')
  await page.screenshot({path:`${shots}/gateway-typescript-editor.png`})
  const response=page.waitForResponse(r=>r.url().includes('/gateways/jobs')&&r.request().method()==='POST')
  await page.getByRole('button',{name:/^(Run|実行)$/,exact:true}).click()
  const queued=await (await response).json()
  if(!queued.job?.id)throw Error('TypeScript job was not queued')
  const claimed=await page.evaluate(async({apiHost,token})=>{
   const r=await fetch(new URL('/gateways/claim',apiHost),{method:'POST',headers:{'content-type':'application/json',authorization:`Bearer ${token}`},body:'{}'})
   if(!r.ok)throw Error(`Local node claim: ${r.status}`)
   return r.json()
  },{apiHost,token:registered.token})
  if(claimed.job?.id!==queued.job.id||claimed.job.payload.language!=='typescript'||claimed.job.payload.code!==code||claimed.job.payload.input!==21)throw Error('Selected TypeScript payload did not reach the assigned node')
  await call('POST',`/gateways/jobs/${queued.job.id}/cancel`,{})
 } catch(error) {
  await page.screenshot({path:`${shots}/gateway-typescript-failure.png`}).catch(()=>{});throw error
 } finally {
  if(nodeId)await call('POST',`/gateways/${nodeId}/revoke`,{}).catch(()=>{})
  if(previousMode)await call('PUT','/orgs/mode',{mode:previousMode}).catch(()=>{})
  await page.close()
 }
}
