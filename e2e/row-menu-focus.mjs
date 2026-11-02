// Exercise the real RowMenu with controllable live updates. This fixture is
// included in the E2E build only and has no authentication or backend data.
import assert from 'node:assert/strict'

export async function rowMenuFocus(browser, base) {
  const ctx = await browser.newContext({ viewport: { width: 1200, height: 800 } })
  const page = await ctx.newPage()
  const url = `${base}/e2e/row-menu-focus.html`
  const action = () => page.locator('#action').textContent()
  const focused = () => page.evaluate(() => ({
    tag: document.activeElement?.tagName,
    role: document.activeElement?.getAttribute('role'),
    data: document.activeElement?.getAttribute('data-row-menu'),
    id: document.activeElement?.id,
  }))
  const update = async (name, value) => {
    await page.evaluate(([name, value]) => window[name](value), [name, value])
    // Wait for React to commit the update instead of relying on a fixed delay.
    if (name === 'setStar') await page.waitForFunction((value) => Boolean(document.querySelector('[data-row-menu=star]')) === value, value)
    if (name === 'setFlipped') await page.waitForFunction((value) => document.querySelector('[data-row-menu=star]')?.textContent?.includes(value ? 'Unstar' : 'Star'), value)
    if (name === 'setUnread') await page.waitForFunction((value) => Boolean(document.querySelector('[data-row-menu=mark-all]')) === value, value)
    if (name === 'setCopy') await page.waitForFunction((value) => Boolean(document.querySelector('[data-row-menu=copy]')) === value, value)
  }
  try {
    for (const [before, after] of [[false, true], [true, false]]) {
      await page.goto(url)
      if (before) await update('setUnread', true)
      await page.locator('[data-row-menu=star]').focus()
      await update('setUnread', after)
      assert.equal((await focused()).data, 'star', 'an unread update moved focus to another action')
      await page.keyboard.press('Enter')
      assert.equal(await action(), 'star', 'the retained action did not execute')

      await page.goto(url)
      if (before) await update('setUnread', true)
      const box = await page.locator('[data-row-menu=star]').boundingBox()
      assert.ok(box, 'no star button')
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await update('setUnread', after)
      await page.mouse.up()
      assert.equal(await action(), '', 'an unread update made the pointer execute another action')
    }
    for (const mode of ['removed', 'changed']) {
      await page.goto(url)
      await page.locator('[data-row-menu=star]').focus()
      await update(mode === 'removed' ? 'setStar' : 'setFlipped', mode === 'changed')
      assert.equal((await focused()).role, 'menu', `${mode}: focus did not return to the menu`)
      await page.keyboard.press('Enter')
      assert.equal(await action(), '', `${mode}: Enter executed another action`)
      await page.keyboard.press('ArrowDown')
      assert.equal((await focused()).data, 'details', `${mode}: arrow did not select a menu item`)
    }
    await page.goto(url)
    await page.locator('[data-row-menu=star]').focus()
    await page.locator('#outside').focus()
    await update('setStar', false)
    assert.equal((await focused()).id, 'outside', 'the menu stole focus from the page')

    await page.goto(url)
    await page.locator('[data-row-menu=star]').focus()
    await page.locator('[data-row-menu=star]').evaluate((el) => el.blur())
    await update('setStar', false)
    assert.equal((await focused()).tag, 'BODY', 'the menu stole focus after an intentional blur')

    for (const mode of ['removed', 'changed']) {
      await page.goto(url)
      const box = await page.locator('[data-row-menu=star]').boundingBox()
      assert.ok(box, 'no star button')
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
      await page.mouse.down()
      await update(mode === 'removed' ? 'setStar' : 'setFlipped', mode === 'changed')
      await page.mouse.up()
      assert.equal(await action(), '', `${mode}: pointer release executed another action`)
    }
    await page.goto(url)
    await page.locator('[data-row-menu=star]').focus()
    await page.keyboard.down('Space')
    await update('setFlipped', true)
    await page.keyboard.up('Space')
    assert.equal(await action(), '', 'releasing a held Space executed another action')

    await page.goto(url)
    await page.locator('[data-row-menu=star]').focus()
    await update('setStar', false)
    await page.evaluate(() => document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, isComposing: true })))
    assert.equal((await focused()).role, 'menu', 'an IME arrow selected a menu item')
    await page.keyboard.press('ArrowDown')
    assert.equal((await focused()).data, 'details', 'an ordinary arrow could not select a menu item')

    await page.goto(url)
    await page.locator('[data-row-menu=star]').focus()
    await page.evaluate(() => { document.hasFocus = () => false })
    await update('setStar', false)
    assert.equal((await focused()).tag, 'BODY', 'a background update moved focus')
    await page.evaluate(() => { document.hasFocus = () => true; window.dispatchEvent(new Event('focus')) })
    assert.equal((await focused()).role, 'menu', 'returning to the window did not recover the menu')

    await page.goto(url)
    await page.locator('[data-row-menu=copy]').click()
    await page.locator('[data-row-menu=copy-link]').focus()
    await update('setUnread', true)
    assert.equal((await focused()).data, 'copy-link', 'an unrelated update moved submenu focus')
    await update('setCopy', false)
    assert.equal((await focused()).role, 'menu', 'removing a submenu did not restore the parent menu focus')
  } finally {
    await ctx.close()
  }
}
