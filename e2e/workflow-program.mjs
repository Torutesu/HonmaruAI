// Disposable local Worker only. Node transport is exercised without a paid model
// or a real user's execution node. VM isolation is verified separately.
export async function workflowProgram({context,web,apiHost,shots}) {
 if(new URL(apiHost).hostname!=='127.0.0.1')throw Error('Program fixtures require the local test Worker')
 const page=await context.newPage();let previousMode,nodeId
 const call=(method,path,body,token)=>page.evaluate(async({method,path,body,token,apiHost})=>{
  const orgId=localStorage.getItem('orgId'),url=new URL(path,apiHost)
  if(method==='GET')url.searchParams.set('orgId',orgId)
  const response=await fetch(url,{method,headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{'x-session-token':localStorage.getItem('sessionToken')})},body:method==='GET'?undefined:JSON.stringify({...body,orgId})})
  if(!response.ok)throw Error(`Program fixture ${method} ${path}: ${response.status}`)
  return response.json()
 },{method,path,body,token,apiHost})
 try {
  await page.goto(web,{waitUntil:'load'})
  await page.waitForFunction(()=>Boolean(localStorage.getItem('sessionToken')&&localStorage.getItem('orgId')))
  previousMode=(await call('GET','/orgs/mode')).mode
  await call('PUT','/orgs/mode',{mode:'harness'})
  const registered=await call('POST','/gateways',{name:`Program fixture ${Date.now()}`});nodeId=registered.gateway.id
  await page.reload({waitUntil:'load'});await page.goto(`${web}#/workflows`,{waitUntil:'load'})
  await page.setViewportSize({width:1440,height:1000})
  const screen=page.locator('.shell > .hx-resource-screen')
  await screen.locator('.screen-head').getByRole('button',{name:/^(Set up an automation|オートメーションを設定)$/}).click()
  await screen.getByRole('button',{name:/^(Manual setup|手動で設定)$/}).click()
  const builder=screen.locator('.hx-builder'),name=`Program UI ${Date.now()}`
  await builder.getByLabel(/^(Workflow name|ワークフロー名)$/).fill(name)
  await builder.getByLabel(/^(Workflow format|ワークフローの形式)$/).selectOption('code')
  const code="import {state} from '@honmaru/workflow-sdk';\nconst previous = await state.get();\nconsole.log(previous);"
  await builder.getByLabel(/^(TypeScript source|TypeScriptソース)$/).fill(code)
  await builder.getByLabel(/^(Execution node|実行ノード)$/,{exact:true}).selectOption(nodeId)
  await builder.getByLabel(/^(Workflow format|ワークフローの形式)$/).selectOption('form')
  await builder.getByLabel(/^(Workflow format|ワークフローの形式)$/).selectOption('code')
  if(await builder.getByLabel(/^(TypeScript source|TypeScriptソース)$/).inputValue()!==code)throw Error('Program draft lost')
  await builder.screenshot({path:`${shots}/workflow-program-editor.png`})
  await page.setViewportSize({width:390,height:844})
  if(await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth+1))throw Error('Program editor overflows mobile viewport')
  await builder.screenshot({path:`${shots}/workflow-program-mobile.png`})
  await builder.getByRole('button',{name:/^(Save workflow|ワークフローを保存)$/}).click({trial:true})
  await page.screenshot({path:`${shots}/workflow-program-mobile-save.png`})
  await page.setViewportSize({width:1440,height:1000});await page.emulateMedia({colorScheme:'dark'})
  const colors=await builder.locator('.hx-program-input').evaluate(element=>({bg:getComputedStyle(element).backgroundColor,fg:getComputedStyle(element).color}))
  if(colors.bg===colors.fg||colors.bg==='rgb(255, 255, 255)')throw Error('Program editor has incorrect dark colors')
  await builder.screenshot({path:`${shots}/workflow-program-dark.png`})
  await builder.getByRole('button',{name:/^(Save workflow|ワークフローを保存)$/}).click()
  const row=screen.locator('[data-workflow]').filter({hasText:name});await row.waitFor({state:'visible'})
  const workflowId=await row.getAttribute('data-workflow');await row.click()
  const saved=await call('GET',`/workflows/${workflowId}`)
  if(saved.workflow.steps[0].code!==code||saved.workflow.steps[0].gatewayId!==nodeId)throw Error('Saved program differs from editor')
  const started=await call('POST',`/workflows/${workflowId}/run`,{input:{fixture:true}})
  if(started.run?.status!=='running')throw Error('Program did not enter running state')
  const claimed=await call('POST','/gateways/claim',{capabilities:['workflow-program-v1']},registered.token),job=claimed.job
  if(!job?.workflow||job.payload.code!==code)throw Error('Node did not receive frozen program')
  const state=await call('POST',`/gateways/jobs/${job.id}/state`,{lease:job.lease,operation:'state.get',params:{}},registered.token)
  await call('POST',`/gateways/jobs/${job.id}/state`,{lease:job.lease,operation:'state.set',params:{expectedRevision:state.revision,state:{fixture:'stored'}}},registered.token)
  const restored=await call('POST',`/gateways/jobs/${job.id}/state`,{lease:job.lease,operation:'state.get',params:{includeCurrentRun:true}},registered.token)
  if(restored.state?.fixture!=='stored'||restored.validationStatus!=='passed')throw Error('Default state write did not commit')
  await call('POST',`/gateways/jobs/${job.id}/finish`,{lease:job.lease,status:'succeeded',stdout:'Fixture completed',stderr:'',exitCode:0},registered.token)
  const completed=await call('GET',`/workflows/${workflowId}`)
  if(completed.runs[0]?.status!=='done'||completed.runs[0].log[0].output!=='Fixture completed')throw Error('Program completion missing from workflow history')
 } catch(error) {
  await page.screenshot({path:`${shots}/workflow-program-failure.png`}).catch(()=>{});throw error
 } finally {
  if(nodeId)await call('POST',`/gateways/${nodeId}/revoke`,{}).catch(()=>{})
  if(previousMode)await call('PUT','/orgs/mode',{mode:previousMode}).catch(()=>{})
  await page.close()
 }
}
