// A key press while the message is still on its way must be handled after
// that particular send lands. Hold the request explicitly instead of racing
// a real network or sleeping for an assumed duration.
export async function pendingMessageDelete(browser, web, phone) {
  const ctx = await browser.newContext({ locale: 'en-US', viewport: { width: 1440, height: 900 }, storageState: await phone.storageState() })
  const page = await ctx.newPage()
  const releases = new Map()
  const deletes = []
  let nativeDialogs = 0
  page.on('dialog', dialog => { nativeDialogs++; void dialog.dismiss() })
  page.on('request', request => {
    if (request.method() === 'DELETE' && new URL(request.url()).pathname === '/channels/messages') deletes.push(request)
  })
  await page.route('**/channels/messages', async route => {
    const request = route.request()
    const body = request.method() === 'POST' ? request.postDataJSON()?.body : null
    const gate = releases.get(body)
    if (!gate) { await route.continue(); return }
    await gate.waitToSend
    try {
      const response = await route.fetch()
      gate.forwarded(response)
      await gate.waitToReply
      await route.fulfill({ response })
    } catch (error) { gate.forwardFailed(error) }
  })
  try {
    await page.goto(`${web}/#/list`, { waitUntil: 'load' })
    await page.waitForSelector('.slk-side', { timeout: 20000 })
    await page.click('.cl-add')
    await page.fill('.cl-add-form input', 'Pending key deletion')
    await page.keyboard.press('Enter')
    await page.waitForSelector('.cl-thread:has-text("Pending key deletion")', { timeout: 15000 })
    await page.click('.cl-thread:has-text("Pending key deletion") .cl-open')
    await page.waitForSelector('.slk-head h1:has-text("Pending key deletion")', { timeout: 10000 })

    async function queueDeletion(body, shift) {
      const deletesBefore = deletes.length
      let releaseSend, releaseReply, forwarded, forwardFailed
      const waitToSend = new Promise(resolve => { releaseSend = resolve })
      const waitToReply = new Promise(resolve => { releaseReply = resolve })
      const serverResponse = new Promise((resolve, reject) => { forwarded = resolve; forwardFailed = reject }).catch(() => null)
      releases.set(body, { waitToSend, waitToReply, releaseSend, releaseReply, forwarded, forwardFailed })
      const requested = page.waitForRequest(request => new URL(request.url()).pathname === '/channels/messages' && request.method() === 'POST' && request.postDataJSON()?.body === body)
      await page.fill('.slk-input', body)
      await page.keyboard.press('Enter')
      await requested
      const row = `.slk-main .slk-msg:has-text("${body}")`
      await page.waitForSelector(row, { timeout: 10000 })
      const tempId = await page.getAttribute(row, 'id')
      if (!tempId?.startsWith('msg-tmp-')) throw new Error('the held send did not remain a temporary message')
      await page.focus('.slk-main .slk-log')
      await page.keyboard.press('ArrowUp')
      await page.waitForFunction(id => document.activeElement?.id === id, tempId, { timeout: 5000 })
      await page.keyboard.press('e')
      const editBox = `${row}.editing .slk-edit textarea`
      await page.waitForSelector(editBox, { timeout: 5000 })
      if (await page.inputValue(editBox) !== body) throw new Error('editing opened a different pending message')
      await page.keyboard.press('Escape')
      await page.waitForFunction(id => document.activeElement?.id === id, tempId, { timeout: 5000 })
      await page.keyboard.press(shift ? 'Shift+Backspace' : 'Backspace')
      if (await page.$('[data-delete-confirm]')) throw new Error('a pending send was confirmed before it landed')
      if (deletes.length !== deletesBefore) throw new Error('a pending send triggered a delete before it landed')
      const response = page.waitForResponse(r => new URL(r.url()).pathname === '/channels/messages' && r.request().method() === 'POST' && r.request().postDataJSON()?.body === body).catch(() => null)
      // Let the server process the message, but withhold its POST response.
      // An event may already update the row; the queued action must still
      // wait for the originating send to settle.
      releaseSend()
      const forwardedResponse = await serverResponse
      if (!forwardedResponse?.ok()) throw new Error(`forwarded message send failed: HTTP ${forwardedResponse?.status() ?? 'network error'}`)
      const forwardedId = (await forwardedResponse.json()).message?.id
      if (typeof forwardedId !== 'string' || !forwardedId || forwardedId.startsWith('tmp-')) throw new Error('forwarded send did not return a server id')
      // Wait until the real event has replaced the temporary row while the
      // original POST response remains held. This checks the out-of-order
      // state itself, rather than a single snapshot before the event arrives.
      await page.waitForSelector(`.slk-main [id="msg-${forwardedId}"]`, { timeout: 10000 })
      if (await page.$('[data-delete-confirm]')) throw new Error('the delete question appeared while the send response was withheld')
      if (deletes.length !== deletesBefore) throw new Error('a delete was sent while the send response was withheld')
      releaseReply()
      const sent = await response
      if (!sent?.ok()) throw new Error(`pending message send failed: HTTP ${sent?.status() ?? 'network error'}`)
      const id = (await sent.json()).message?.id
      if (typeof id !== 'string' || !id || id.startsWith('tmp-')) throw new Error('pending send did not receive a server id')
      if (id !== forwardedId) throw new Error('the send response did not match the forwarded message')
      return { row, id }
    }

    const normal = await queueDeletion('pending keyboard confirmation', false)
    await page.waitForSelector('.cl-delete-dialog [data-delete-preview]:has-text("pending keyboard confirmation")', { timeout: 10000 })
    if (deletes.length) throw new Error('the confirmed delete question sent a delete request')
    await page.keyboard.press('Escape')
    await page.waitForSelector('[data-delete-confirm]', { state: 'detached', timeout: 5000 })
    if (!await page.$(`.slk-main [id="msg-${normal.id}"]`)) throw new Error('canceling the question removed the sent message')
    if (deletes.length !== 0) throw new Error('canceling the question sent a delete request')

    const approved = await queueDeletion('pending keyboard approve', false)
    await page.waitForSelector('.cl-delete-dialog [data-delete-preview]:has-text("pending keyboard approve")', { timeout: 10000 })
    if (deletes.length !== 0) throw new Error('the approval question sent a delete before confirmation')
    // Start observing only after the question is visible and its no-delete
    // check has passed, so an earlier request cannot satisfy this waiter.
    const approvedDelete = page.waitForResponse(response => new URL(response.url()).pathname === '/channels/messages' && response.request().method() === 'DELETE').catch(() => null)
    await page.click('[data-delete-confirm]')
    const approvedResponse = await approvedDelete
    if (!approvedResponse?.ok() || approvedResponse.request().postDataJSON()?.messageId !== approved.id) throw new Error('confirmation did not delete the acknowledged pending message')
    await page.waitForSelector(approved.row, { state: 'detached', timeout: 10000 })
    if (deletes.length !== 1) throw new Error('confirmation sent an unexpected number of deletes')

    const removed = page.waitForResponse(response => new URL(response.url()).pathname === '/channels/messages' && response.request().method() === 'DELETE').catch(() => null)
    const shifted = await queueDeletion('pending keyboard skip', true)
    const deletion = await removed
    if (!deletion?.ok() || deletion.request().postDataJSON()?.messageId !== shifted.id) throw new Error('Shift+Backspace did not delete the acknowledged pending message')
    await page.waitForSelector(shifted.row, { state: 'detached', timeout: 10000 })
    if (await page.$('[data-delete-confirm]')) throw new Error('Shift+Backspace asked after the pending send')
    if (deletes.length !== 2 || nativeDialogs) throw new Error('unexpected delete request or native dialog')
  } finally {
    for (const gate of releases.values()) { gate.releaseSend(); gate.releaseReply() }
    await ctx.close()
  }
}
