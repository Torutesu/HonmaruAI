// Runs only against the disposable local Worker used by e2e/run.sh.
// The template generator is explicitly model-free; no external model call.
export async function appSourceNavigation({ context, web, apiHost, shots }) {
  if (new URL(apiHost).hostname !== '127.0.0.1') throw new Error('Source-navigation fixtures require the local test Worker')
  const page = await context.newPage()
  await page.setViewportSize({ width: 1440, height: 900 })
  let stage = 'fixture setup', navigation = 0
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
    // Fixtures changed the room list and mode through the API. Reload so
    // the mounted shell reads them before exercising UI navigation.
    await page.reload({ waitUntil: 'load' })
    const appUrl = `${web}#/apps/${made.app.id}/${encodeURIComponent(orgId)}`
    const openAdjustment = async () => {
      navigation += 1
      stage = 'open app route'
      await page.goto(appUrl, { waitUntil: 'load' })
      // The creation thread remains mounted behind the standalone screen.
      // Scope to the foreground app so its hidden panel cannot capture this locator.
      const foreground = page.locator('.shell > .hx-app-detail')
      await foreground.locator('.hx-data-toolbar').waitFor({ timeout: 20000 })
      if (!(await page.locator('.classic').getAttribute('inert') === '')) throw new Error('Covered conversation remained interactive')
      if (navigation > 1) {
        await page.locator('.classic .slk-thread-pane .slk-composer textarea').focus()
        if (await page.evaluate(() => Boolean(document.activeElement?.closest('.classic')))) throw new Error('Covered conversation stole keyboard focus')
      }
      stage = 'open filter popover'
      await foreground.getByRole('button', { name: 'フィルター', exact: true }).click()
      stage = 'adjust filter'
      await foreground.getByRole('button', { name: 'フィルターを調整', exact: true }).click()
      stage = 'wait for source thread'
      await page.locator('.slk-thread-pane .slk-composer textarea').waitFor({ timeout: 20000 })
      if (await page.locator('.classic').getAttribute('inert') !== null) throw new Error('Source conversation did not become interactive again')
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
    stage = 'float app above workspace'
    const appScreen = page.locator('.shell > .hx-app-detail')
    await appScreen.getByRole('button', { name: 'その他のアプリ操作', exact: true }).click()
    await appScreen.getByRole('menuitem', { name: 'ワークスペース上にフローティング表示', exact: true }).click()
    const floating = page.getByRole('region', { name: 'フローティングアプリ', exact: true })
    await floating.locator('.hx-data-toolbar').waitFor({ timeout: 20000 })
    const initialBox = await floating.boundingBox()
    await floating.focus()
    await floating.press('ArrowLeft')
    const movedBox = await floating.boundingBox()
    if (!initialBox || !movedBox || movedBox.x >= initialBox.x) throw new Error('Floating app did not move with keyboard')
    // Changing the workspace's current screen must not discard its small window.
    await page.goto(`${web}#/apps`, { waitUntil: 'load' })
    await floating.locator('.hx-data-toolbar').waitFor({ timeout: 20000 })
    await page.setViewportSize({ width: 700, height: 600 })
    await page.waitForFunction(() => {
      const r = document.querySelector('.hx-floating-app')?.getBoundingClientRect()
      return r && r.left >= 0 && r.top >= 0 && r.right <= innerWidth && r.bottom <= innerHeight
    })
    await page.screenshot({ path: `${shots}/app-floating.png` })
    await floating.getByRole('button', { name: 'フローティングアプリを閉じる', exact: true }).click()
    await floating.waitFor({ state: 'detached' })

  } catch (error) {
    console.error(`Source navigation failed at ${stage} (navigation ${navigation}): ${String(error)}`)
    console.error('Filter hit-test diagnostics', JSON.stringify(await page.evaluate(() => Array.from(document.querySelectorAll('.hx-view-controls > button')).map(button => {
      const r = button.getBoundingClientRect(), hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)
      const describe = element => element ? {tag: element.tagName, classes: element.className, text: element.textContent?.slice(0,80), pointerEvents: getComputedStyle(element).pointerEvents, zIndex: getComputedStyle(element).zIndex, rect: element.getBoundingClientRect().toJSON()} : null
      const ancestors = []; for (let parent = button.parentElement; parent && ancestors.length < 7; parent = parent.parentElement) ancestors.push(describe(parent))
      return {button: describe(button), hit: describe(hit), ancestors, viewport: {width: innerWidth, height: innerHeight, scale: visualViewport?.scale}}
    })).catch(error => String(error))))
    await page.screenshot({ path: `${shots}/app-source-failure.png` }).catch(() => {})
    throw error
  } finally {
    if (previousMode) await call('PUT', '/orgs/mode', { mode: previousMode }).catch(() => {})
    await page.close()
  }
}
