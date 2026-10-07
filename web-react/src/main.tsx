import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'
import './appearance.css'
import { applyStoredLocale } from './utils/i18n'
import { registerShell, watchInstallPrompt } from './utils/install'
import { installAuthGuard } from './utils/authGuard'
import { installAppearance } from './utils/appearance'
import { pathToHash } from './utils/route'

// A link from outside (https://app.honmaruai.com/c/…, /join/…) — the same
// address the phone apps open — becomes this page's own hash route, before
// anything reads the address. Pages serves index.html for every path.
{
  const hash = pathToHash(location.pathname + location.search)
  if (hash) history.replaceState(null, '', `/${hash}`)
}

// So <html lang> agrees with the stored choice, and its words are here,
// before anything paints.
const localeLoaded = applyStoredLocale()
// The shell for offline, and the install offer kept for You.
registerShell()
watchInstallPrompt()
// A workspace's login rules, and admin actions that want a recent sign-in.
installAuthGuard()
// The theme index.html already drew, and another tab's choice followed.
installAppearance()

void localeLoaded.finally(() => {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </React.StrictMode>,
  )
})
