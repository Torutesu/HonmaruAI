// Runs only against the disposable local Worker used by e2e/run.sh.
// The template generator is explicitly model-free; no external model call.
export async function appSourceNavigation({ context, web, apiHost, shots }) {
  if (new URL(apiHost).hostname !== '127.0.0.1') throw new Error('Source-navigation fixtures require the local test Worker')
  const page = await context.newPage()
  await page.setViewportSize({ width: 1440, height: 900 })
  let previousMode
  const call = (method, path, body) => page.evaluate(async ({ apiHost, method, path, body }) => {
    const orgId = localStorage.getItem('orgId')
    const url = new URL(path, apiHost)
    if (method === 'GET') url.searchParams.set('orgId', orgId)
    const response = await fetch(url, {
      method, headers: { 'content-type': 'application/json', 'x-session-token': localStorage.getItem('sessionToken') },
      body: method === 'GET' ? undefined : JSON.stringify({ ...body, orgId }),
    })
    const data = await response.json()
    if (!response.ok) throw new Error(`Source fixture ${method} ${path}: ${response.status}`)
    return data
  }, { apiHost, method, path, body })
  try {
    await page.goto(web, { waitUntil: 'load' })
    await page.waitForFunction(() => Boolean(localStorage.getItem('sessionToken') && localStorage.getItem('orgId')))
    previousMode = (await call('GET', '/orgs/mode')).mode
    const room = await call('POST', '/businesses', { name: `Source navigation ${Date.now()}`, private: true })
    const prompt = `Build a task tracker for source navigation ${Date.now()}`
    const made = await call('POST', '/apps/generate', {
      prompt, channel: `b:${room.business.slug}`, captureSource: true,
      requestId: `e2e_source_${Date.now()}`, useModel: false,
    })
    const before = await call('GET', `/apps/${made.app.id}/conversation`)
    if (!before.source?.messages.some(message => message.body === prompt)) throw new Error('Fixture did not retain its creation request')
    const orgId = await page.evaluate(() => localStorage.getItem('orgId'))
    await call('PUT', '/orgs/mode', { mode: 'harness' })
    const appUrl = `${web}#/apps/${made.app.id}/${encodeURIComponent(orgId)}`
    const openAdjustment = async () => {
      await page.goto(appUrl, { waitUntil: 'load' })
      await page.locator('.hx-data-toolbar').waitFor({ timeout: 20000 })
      await page.getByRole('button', { name: 'フィルター', exact: true }).click()
      await page.getByRole('button', { name: 'フィルターを調整', exact: true }).click()
      await page.locator('.slk-thread-pane .slk-composer textarea').waitFor({ timeout: 20000 })
      await page.locator('.hx-app-pane .hx-data-toolbar').waitFor({ timeout: 20000 })
      if (!(await page.locator('.slk-thread-pane').innerText()).includes(prompt)) throw new Error('Wrong creation thread opened')
    }
    await openAdjustment()
    const reply = page.locator('.slk-thread-pane .slk-composer textarea')
    await page.waitForFunction(() => document.querySelector('.slk-thread-pane .slk-composer textarea')?.value.includes('フィルターを調整：'))
    await reply.fill('Existing unsent source draft — keep this text')
    // Reload through the app route, then ask to adjust again. The saved
    // thread draft must win over the generated suggestion.
    await openAdjustment()
    if (await reply.inputValue() !== 'Existing unsent source draft — keep this text') throw new Error('Adjustment replaced the existing source draft')
    const after = await call('GET', `/apps/${made.app.id}/conversation`)
    if (JSON.stringify(after.source.messages.map(message => [message.id, message.body])) !== JSON.stringify(before.source.messages.map(message => [message.id, message.body]))) throw new Error('Navigation unexpectedly posted a message')
    await page.screenshot({ path: `${shots}/app-source-adjustment.png` })
    await reply.fill('')
    const standalone = await call('POST', '/apps/generate', {
      prompt: 'Build a task tracker for app draft persistence', channel: `b:${room.business.slug}`,
      captureSource: false, requestId: `e2e_draft_${Date.now()}`, useModel: false,
    })
    const standaloneUrl = `${web}#/apps/${standalone.app.id}/${encodeURIComponent(orgId)}?section=data&chat=1`
    await page.goto(standaloneUrl, { waitUntil: 'load' })
    const appReply = page.locator('.hx-object-chat textarea')
    await appReply.waitFor({ timeout: 20000 })
    await appReply.fill('Unsent app draft survives navigation')
    await page.reload({ waitUntil: 'load' })
    await appReply.waitFor({ timeout: 20000 })
    await page.waitForFunction(() => document.querySelector('.hx-object-chat textarea')?.value === 'Unsent app draft survives navigation')
    const standaloneConversation = await call('GET', `/apps/${standalone.app.id}/conversation`)
    if (standaloneConversation.messages.length) throw new Error('Saving an app draft unexpectedly posted a message')
    await page.screenshot({ path: `${shots}/app-draft-restored.png` })
    await appReply.fill('')
  } finally {
    if (previousMode) await call('PUT', '/orgs/mode', { mode: previousMode }).catch(() => {})
    await page.close()
  }
}
