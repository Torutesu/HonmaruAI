import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'
import { applyStoredLocale } from './utils/i18n'
import { registerShell, watchInstallPrompt } from './utils/install'
import { installAuthGuard } from './utils/authGuard'

// So <html lang> agrees with the stored choice before anything paints.
applyStoredLocale()
// The shell for offline, and the install offer kept for You.
registerShell()
watchInstallPrompt()
// A workspace's login rules, and admin actions that want a recent sign-in.
installAuthGuard()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
