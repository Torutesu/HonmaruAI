import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import './index.css'
import './responsive.css'
import '@fontsource/inter/400.css'
import '@fontsource/inter/500.css'
import '@fontsource/inter/600.css'
import '@fontsource/inter/700.css'
import '@fontsource/plus-jakarta-sans/600.css'
import '@fontsource/plus-jakarta-sans/700.css'
import '@fontsource/sometype-mono/500.css'
import { applyStoredLocale } from './utils/i18n'

// So <html lang> agrees with the stored choice before anything paints.
applyStoredLocale()

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
)
