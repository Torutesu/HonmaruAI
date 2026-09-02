import React, { useState, useEffect } from 'react'
import { Dashboard } from './components/Dashboard'
import './App.css'

function App() {
  const [userId, setUserId] = useState<string | null>(null)
  const [orgId, setOrgId] = useState<string>(import.meta.env.VITE_ORG_ID || 'core-team')
  const [relayUrl, setRelayUrl] = useState<string>(import.meta.env.VITE_RELAY_URL || 'ws://localhost:8080')
  const [isConfiguring, setIsConfiguring] = useState(true)
  const [userInput, setUserInput] = useState('')
  const [urlInput, setUrlInput] = useState(relayUrl)
  const [sessionToken, setSessionToken] = useState<string>('')

  useEffect(() => {
    const savedUserId = localStorage.getItem('userId')
    const savedRelayUrl = localStorage.getItem('relayUrl')
    const savedToken = localStorage.getItem('sessionToken')
    if (savedToken) setSessionToken(savedToken)
    const savedOrg = localStorage.getItem('orgId')
    if (savedOrg) setOrgId(savedOrg)

    if (savedUserId) {
      setUserId(savedUserId)
      setIsConfiguring(false)
    }

    if (savedRelayUrl) {
      setRelayUrl(savedRelayUrl)
      setUrlInput(savedRelayUrl)
    }
  }, [])

  const handleConnect = (e: React.FormEvent) => {
    e.preventDefault()

    if (!userInput.trim()) {
      alert('Please enter a user ID')
      return
    }

    const newUserId = userInput.trim()
    setUserId(newUserId)
    setRelayUrl(urlInput)
    setIsConfiguring(false)

    localStorage.setItem('userId', newUserId)
    localStorage.setItem('relayUrl', urlInput)
    localStorage.setItem('sessionToken', sessionToken.trim())
    localStorage.setItem('orgId', orgId.trim())
  }

  const handleLogout = () => {
    setUserId(null)
    setIsConfiguring(true)
    localStorage.removeItem('userId')
    localStorage.removeItem('sessionToken')
  }

  if (isConfiguring || !userId) {
    return (
      <div className="login-page">
        <div className="login-container">
          <h1>Honmaru AI</h1>
          <p className="subtitle">Web Client</p>

          <form onSubmit={handleConnect}>
            <div className="form-group">
              <label htmlFor="user-id">User ID:</label>
              <input
                id="user-id"
                type="text"
                value={userInput}
                onChange={(e) => setUserInput(e.target.value)}
                placeholder="Enter your user ID"
                autoFocus
              />
            </div>

            <div className="form-group">
              <label htmlFor="relay-url">Relay WebSocket URL:</label>
              <input
                id="relay-url"
                type="text"
                value={urlInput}
                onChange={(e) => setUrlInput(e.target.value)}
                placeholder="ws://localhost:8787"
              />
            </div>

            <div className="form-group">
              <label htmlFor="org-id">Organization ID:</label>
              <input
                id="org-id"
                type="text"
                value={orgId}
                onChange={(e) => setOrgId(e.target.value)}
                placeholder="core-team"
              />
            </div>

            <div className="form-group">
              <label htmlFor="session-token">Session Token:</label>
              <input
                id="session-token"
                type="text"
                value={sessionToken}
                onChange={(e) => setSessionToken(e.target.value)}
                placeholder="Paste your session token"
              />
            </div>

            <button type="submit" className="connect-button">
              Connect
            </button>
          </form>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <Dashboard userId={userId} orgId={orgId} relayUrl={relayUrl} sessionToken={sessionToken} />
      <button className="logout-button" onClick={handleLogout}>
        Logout
      </button>
    </div>
  )
}

export default App