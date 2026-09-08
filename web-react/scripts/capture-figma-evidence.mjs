// Visual evidence only: isolated local sample; never loads account state or a provider.
import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..')
const base = process.env.WEB_QA_URL || 'http://127.0.0.1:4319'
assert(['127.0.0.1','localhost','[::1]'].includes(new URL(base).hostname))
const output = process.env.WEB_QA_OUTPUT || path.join(root, 'docs/figma-alignment/2026-09-08/after')
await mkdir(output,{recursive:true})
const browser=await chromium.launch({headless:true})
const context=await browser.newContext({viewport:{width:390,height:844},deviceScaleFactor:2,colorScheme:'light',locale:'en-US'})
const page=await context.newPage(), errors=[]
let sample=false
await context.route('**/*',route=>{const url=new URL(route.request().url());if(['http:','https:'].includes(url.protocol) && url.origin!==new URL(base).origin){errors.push(`Unexpected request: ${url.origin}`);return route.abort()};return route.continue()})
page.on('websocket',socket=>{if(sample&&!new URL(socket.url()).searchParams.has('token'))errors.push('Unexpected sample WebSocket')})
page.on('pageerror',error=>errors.push(error.message))
const ready=async()=>{await page.evaluate(()=>document.fonts.ready);await page.waitForTimeout(100)}
const shot=async(name)=>{await ready();await page.screenshot({path:path.join(output,name+'.png')})}
try{
  await page.goto(base);await shot('web-welcome-mobile')
  await page.setViewportSize({width:1440,height:1000});await shot('web-welcome-desktop')
  sample=true;await page.goto(base+'/?demo=figma');await page.setViewportSize({width:390,height:844});await shot('web-decision-figma-fixture-mobile')
  assert.equal(await page.getByRole('button',{name:'Approve',exact:true}).count(),1,'Offscreen actions must be hidden from accessibility')
  await page.setViewportSize({width:1440,height:1000});await shot('web-decision-figma-fixture-desktop')
  await page.getByRole('tab',{name:'Classic',exact:true}).click();await shot('web-classic-desktop')
  await page.setViewportSize({width:390,height:844});await shot('web-classic-mobile')
  await page.locator('.tabbar [data-tab=you]').click();await shot('web-profile-demo-mobile')
  assert(await page.locator('.tabbar').isVisible())
  await page.setViewportSize({width:1440,height:1000});await shot('web-profile-demo-desktop')
  await page.setViewportSize({width:390,height:844});await page.emulateMedia({colorScheme:'dark'});await shot('web-profile-demo-mobile-dark')
  await page.getByLabel('Language',{exact:true}).selectOption('ja');await shot('web-profile-demo-ja-dark')
  assert(await page.locator('.classic').evaluate(element=>element.inert),'Language remount must preserve background isolation')
  await page.emulateMedia({colorScheme:'light'});await shot('web-profile-demo-ja-mobile')
  await page.locator('.tabbar [data-tab=feed]').click();await shot('web-decision-demo-ja-mobile')
  await page.locator('.tabbar [data-tab=you]').click();await page.getByLabel('言語',{exact:true}).selectOption('en');await page.locator('.tabbar [data-tab=feed]').click()
  await page.emulateMedia({colorScheme:'dark'});await shot('web-decision-mobile-dark')
  assert.notEqual(await page.locator('.card-title').first().evaluate(element=>getComputedStyle(element).color),'rgb(17, 17, 17)')
  await page.emulateMedia({colorScheme:'light'});await page.locator('.tabbar [data-tab=compose]').click();const dialog=page.getByRole('dialog')
  await dialog.getByLabel('Recipient',{exact:true}).selectOption('sample:maya');await dialog.getByLabel('What needs your attention?',{exact:true}).fill('Please review the interview plan before Thursday.');await dialog.getByRole('button',{name:'Review request',exact:true}).click();await shot('web-compose-preview-mobile')
  const footer=await dialog.locator('.compose-actions').boundingBox();assert(footer.y+footer.height<=844,'Preview actions must remain on screen')
  await dialog.getByRole('button',{name:'Close',exact:true}).click()
  await page.evaluate(()=>{const nodes=[...document.querySelectorAll('.feed .card-title,.feed .card-summary,.feed .rb-quote,.feed .rb-label,.feed .rec-reason,.feed .rec-head,.feed .card-kind,.feed .legend,.ask-bar input')];const values=nodes.map(node=>[node,parseFloat(getComputedStyle(node).fontSize)*1.3]);for(const [node,size]of values)node.style.fontSize=size+'px'})
  await shot('web-decision-large-text-simulation')
  await page.locator('.page:not([aria-hidden]) .card').evaluate(element=>{element.scrollTop=element.scrollHeight})
  await shot('web-decision-large-text-scrolled')
  assert(await page.locator('.page:not([aria-hidden]) .card').evaluate(element=>element.scrollHeight-element.scrollTop<=element.clientHeight+1),'Enlarged text must remain scrollable to the end')
  const geometry=await page.evaluate(()=>({overflow:document.documentElement.scrollWidth>innerWidth,action:document.querySelector('.page:not([aria-hidden]) .decide-row').getBoundingClientRect().bottom,ask:document.querySelector('.page:not([aria-hidden]) .ask-area').getBoundingClientRect().top,nav:document.querySelector('.tabbar').getBoundingClientRect().top}));assert(!geometry.overflow);assert(geometry.action<=geometry.ask)
  await page.reload();await page.setViewportSize({width:320,height:768});await shot('web-decision-narrow-mobile');assert(!await page.evaluate(()=>document.documentElement.scrollWidth>innerWidth))
  const source=await readFile(path.join(root,'docs/figma-alignment/2026-09-08/reference/decision-frame.png')), actual=await readFile(path.join(output,'web-decision-figma-fixture-mobile.png'))
  await page.setViewportSize({width:820,height:884});await page.setContent(`<body style="margin:0;background:#ddd;font:12px system-ui;display:flex;gap:20px;padding:0 10px"><section><p style="height:20px;margin:10px 0">Figma 470:282 — source @2×</p><img width="390" height="844" src="data:image/png;base64,${source.toString('base64')}"></section><section><p style="height:20px;margin:10px 0">Web 390×844 — local fixture @2×</p><img width="390" height="844" src="data:image/png;base64,${actual.toString('base64')}"></section></body>`);await page.screenshot({path:path.join(output,'web-decision-comparison.png')})
  assert.deepEqual(errors,[])
  await writeFile(path.join(output,'web-visual-checks.json'),JSON.stringify({at:new Date().toISOString(),viewport:'390×844 CSS pixels, density2; desktop1440×1000; narrow320×768',environment:'Local sample workspace. No backend/provider/account/session state loaded.',checks:['Only current card exposed to accessibility','Profile navigation visible','Language remount keeps background inert','Dark title foreground readable','Preview footer inside mobile viewport','30% text-enlargement simulation keeps actions and no horizontal overflow','320px width has no horizontal overflow','Zero unexpected network requests and browser errors'],largeText:'Explicit 30% text-size robustness simulation; not an OS accessibility setting or device qualification'},null,2))
  console.log(`Visual evidence passed: ${output}`)
}finally{await browser.close()}
