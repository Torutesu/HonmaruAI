// Model-free fixtures against the disposable CI Worker only.
export async function workflowConditions({context,web,apiHost,shots}) {
 if(new URL(apiHost).hostname!=='127.0.0.1')throw Error('Workflow condition fixtures require the local test Worker')
 const page=await context.newPage()
 await page.setViewportSize({width:1440,height:1000})
 let previousMode
 const call=(method,path,body)=>page.evaluate(async({method,path,body,apiHost})=>{
  const orgId=localStorage.getItem('orgId'),url=new URL(path,apiHost)
  if(method==='GET')url.searchParams.set('orgId',orgId)
  const response=await fetch(url,{method,headers:{'content-type':'application/json','x-session-token':localStorage.getItem('sessionToken')},body:method==='GET'?undefined:JSON.stringify({...body,orgId})})
  if(!response.ok)throw Error(`Workflow fixture ${method} ${path}: ${response.status}`)
  return response.json()
 },{method,path,body,apiHost})
 try {
  await page.goto(web,{waitUntil:'load'})
  await page.waitForFunction(()=>Boolean(localStorage.getItem('sessionToken')&&localStorage.getItem('orgId')))
  previousMode=(await call('GET','/orgs/mode')).mode
  const {business}=await call('POST','/businesses',{name:`Conditional workflow ${Date.now()}`,private:true})
  await call('PUT','/orgs/mode',{mode:'harness'})
  await page.reload({waitUntil:'load'})
  await page.goto(`${web}#/workflows`,{waitUntil:'load'})
  const screen=page.locator('.shell > .hx-resource-screen')
  await screen.locator('.screen-head').getByRole('button',{name:/^(Set up an automation|オートメーションを設定)$/}).click()
  await screen.getByRole('button',{name:/^(Manual setup|手動で設定)$/}).click()
  const builder=screen.locator('.hx-builder'),name=`Conditional UI ${Date.now()}`
  await builder.getByLabel(/^(Workflow name|ワークフロー名)$/).fill(name)
  await builder.locator('input[placeholder="#ops"]').fill(`#${business.slug}`)
  await builder.locator('textarea').fill('This local fixture must not post for an unmatched condition')
  await builder.getByRole('checkbox',{name:'条件に合う場合だけ実行'}).check()
  await builder.getByLabel('条件の項目',{exact:true}).fill('amount')
  await builder.getByLabel('条件の比較方法',{exact:true}).selectOption('gte')
  await builder.getByLabel('比較する値',{exact:true}).fill('100')
  await builder.getByLabel('条件の組み合わせ',{exact:true}).selectOption('all')
  await builder.getByRole('button',{name:'条件を追加',exact:true}).click()
  await builder.getByLabel('条件の項目',{exact:true}).nth(1).fill('currency')
  await builder.getByLabel('比較する値',{exact:true}).nth(1).fill('JPY')
  await page.screenshot({path:`${shots}/workflow-condition-editor.png`})
  await builder.getByRole('button',{name:/^(Save workflow|ワークフローを保存)$/}).click()
  const row=screen.locator('[data-workflow]').filter({hasText:name})
  await row.waitFor({state:'visible'})
  const id=await row.getAttribute('data-workflow')
  const expected={all:[{path:['input','amount'],op:'gte',value:100},{path:['input','currency'],op:'eq',value:'JPY'}]}
  const saved=await call('GET',`/workflows/${id}`)
  if(JSON.stringify(saved.workflow.steps[0].when)!==JSON.stringify(expected))throw Error('Condition editor did not persist its typed expression')
  await row.click()
  await screen.locator('.hx-flow-condition').waitFor({state:'visible'})
  await page.reload({waitUntil:'load'})
  const description=screen.locator('.hx-flow-condition')
  await description.waitFor({state:'visible'})
  const text=await description.innerText()
  if(!text.includes('amount ≥ 100')||!text.includes('currency = "JPY"'))throw Error('Saved conditions are not visible in workflow details')
  await page.screenshot({path:`${shots}/workflow-condition-detail.png`})
  const path=`/channels/messages?channel=${encodeURIComponent(`b:${business.slug}`)}`
  const before=await call('GET',path)
  const {run}=await call('POST',`/workflows/${id}/run`,{input:{amount:10,currency:'JPY'}})
  if(run.status!=='done'||run.log[0]?.status!=='skipped')throw Error('Unmatched condition did not skip its effect')
  const after=await call('GET',path)
  if(JSON.stringify(before.messages)!==JSON.stringify(after.messages))throw Error('Unmatched workflow condition posted a message')
 } catch(error) {
  await page.screenshot({path:`${shots}/workflow-condition-failure.png`}).catch(()=>{})
  throw error
 } finally {
  if(previousMode)await call('PUT','/orgs/mode',{mode:previousMode}).catch(()=>{})
  await page.close()
 }
}
