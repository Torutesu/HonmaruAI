// A real Chromium check of the published app's opaque-origin srcdoc policy.
// Asset responses are intercepted locally; no upstream service or credentials are used.
export async function commitAssetPolicy({ page, apiHost }) {
  const sha = 'a'.repeat(40)
  const token = 'e2e-scoped-token'
  const base = `${apiHost}/app-commit-assets/e2e-app/${sha}/${token}/`
  const seen = []
  await page.route(`${base}**`, async route => {
    const path = new URL(route.request().url()).pathname
    seen.push(path)
    if (path.endsWith('/app.js')) return route.fulfill({ status: 200, contentType: 'text/javascript', body: "document.documentElement.dataset.commitScript='loaded';" })
    if (path.endsWith('/app.css')) return route.fulfill({ status: 200, contentType: 'text/css', body: 'html{background:rgb(1,2,3)}' })
    if (path.endsWith('/pixel.svg')) return route.fulfill({ status: 200, contentType: 'image/svg+xml', body: '<svg xmlns="http://www.w3.org/2000/svg" width="2" height="2"><rect width="2" height="2" fill="red"/></svg>' })
    return route.fulfill({ status: 404, body: 'not found' })
  })
  let externalRequests = 0
  const onRequest = request => { if (new URL(request.url()).hostname === 'evil.invalid') externalRequests++ }
  page.on('request', onRequest)
  try {
    const policy = `default-src 'none'; script-src 'unsafe-inline' ${base}; style-src 'unsafe-inline' ${base}; img-src ${base} data:; font-src ${base} data:; connect-src 'none'; frame-src 'none'; form-action 'none'; base-uri ${base}`
    const srcdoc = `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${policy}"><base href="${base}"><link rel="stylesheet" href="app.css"><script src="app.js"></script></head><body><img id="local" src="pixel.svg"><img id="external" src="https://evil.invalid/pixel.png"><script>addEventListener('securitypolicyviolation',event=>{if(event.violatedDirective.startsWith('connect-src'))document.documentElement.dataset.connectBlocked='yes'});fetch('https://evil.invalid/api',{mode:'no-cors'}).catch(()=>document.documentElement.dataset.fetchRejected='yes');document.querySelector('#external').onerror=()=>document.documentElement.dataset.externalImageBlocked='yes'</script></body></html>`
    await page.setContent(`<!doctype html><iframe title="Pinned app" sandbox="allow-scripts" srcdoc="${srcdoc.replaceAll('&','&amp;').replaceAll('"','&quot;')}"></iframe>`)
    const frame = page.frameLocator('iframe[title="Pinned app"]')
    await frame.locator('html[data-commit-script="loaded"]').waitFor({ timeout: 10000 })
    const background = await frame.locator('html').evaluate(element => getComputedStyle(element).backgroundColor)
    if (background !== 'rgb(1, 2, 3)') throw new Error(`Scoped CSS was blocked or not applied: ${background}`)
    const imageLoaded = await frame.locator('#local').evaluate(image => new Promise(resolve => {
      if (image.complete) return resolve(image.naturalWidth > 0)
      image.onload = () => resolve(image.naturalWidth > 0)
      image.onerror = () => resolve(false)
    }))
    if (!imageLoaded) throw new Error('Scoped image did not load in the opaque-origin app frame')
    await frame.locator('html[data-connect-blocked="yes"]').waitFor({ timeout: 10000 })
    await frame.locator('html[data-external-image-blocked="yes"]').waitFor({ timeout: 10000 })
    if (externalRequests !== 0) throw new Error('The sandbox attempted a request to an external origin')
    if (!seen.some(path => path.endsWith('/app.js')) || !seen.some(path => path.endsWith('/app.css')) || !seen.some(path => path.endsWith('/pixel.svg'))) {
      throw new Error(`The pinned same-origin asset base was not used: ${JSON.stringify(seen)}`)
    }
  } finally {
    page.off('request', onRequest)
    await page.unroute(`${base}**`)
  }
}
