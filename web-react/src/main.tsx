import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { DesktopAside } from './components/DesktopAside'
import './index.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <DesktopAside />
    <App />
  </React.StrictMode>,
)
