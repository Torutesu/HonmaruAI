import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { ErrorBoundary } from './components/ErrorBoundary'
import './index.css'
import { applyStoredLocale } from './utils/i18n'
import { registerShell, watchInstallPrompt } from './utils/install'

// So <html lang> agrees with the stored choice before anything paints.
applyStoredLocale()
// The shell for offline, and the install offer kept for You.
registerShell()
watchInstallPrompt()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
)
