// This small classic script does not depend on React, translations or module imports.
// It never clears storage or reloads automatically.
(() => {
  const panel = document.getElementById('app-startup')
  const root = document.getElementById('root')
  if (!panel || !root) return
  let language = navigator.language || 'en'
  try { language = localStorage.getItem('locale') || new URLSearchParams(location.search).get('lang') || language } catch {}
  const messages = {
    en: ['Opening your workspace…', 'The workspace is taking longer to open. Check your connection and try reloading.', 'Reload'],
    ja: ['ワークスペースを開いています…', '画面の読み込みに時間がかかっています。通信状態を確認して、再読み込みしてください。', '再読み込み'],
    es: ['Abriendo tu espacio de trabajo…', 'La carga está tardando más de lo esperado. Revisa tu conexión y vuelve a cargar.', 'Volver a cargar'],
    fr: ['Ouverture de votre espace de travail…', 'Le chargement prend plus de temps que prévu. Vérifiez votre connexion et rechargez la page.', 'Recharger'],
    de: ['Arbeitsbereich wird geöffnet…', 'Das Laden dauert länger als erwartet. Prüfe deine Verbindung und lade die Seite neu.', 'Neu laden'],
  }
  const words = messages[language.toLowerCase().split(/[-_]/)[0]] || messages.en
  panel.querySelector('[data-startup-message]').textContent = words[0]
  const retry = panel.querySelector('[data-startup-retry]')
  retry.textContent = words[2]
  retry.addEventListener('click', event => { event.preventDefault(); location.reload() })
  const slow = () => {
    if (!root.childElementCount) panel.querySelector('[data-startup-message]').textContent = words[1]
  }
  const timer = setTimeout(slow, 12000)
  const failed = event => {
    if (event.target?.tagName === 'SCRIPT' || event instanceof ErrorEvent) slow()
  }
  window.addEventListener('error', failed, true)
  const observer = new MutationObserver(() => {
    if (!root.childElementCount) return
    clearTimeout(timer)
    window.removeEventListener('error', failed, true)
    observer.disconnect()
    panel.remove()
  })
  observer.observe(root, { childList: true })
})()
