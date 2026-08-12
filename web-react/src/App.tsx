import React, { useState, useEffect } from 'react'
import { Dashboard } from './components/Dashboard'
import './App.css'

function App() {
  const [userId, setUserId] = useState<string | null>(null)
  const [orgId, setOrgId] = useState<string>('core-team')
  const [relayUrl, setRelayUrl] = useState<string>('ws://localhost:8080')
  const [isConfiguring, setIsConfiguring] = useState(true)
  const [userInput, setUserInput] = useState('')
  const [urlInput, setUrlInput] = useState(relayUrl)

  useEffect(() => {
    const savedUserId = localStorage.getItem('userId')
    const savedRelayUrl = localStorage.getItem('relayUrl')

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
  }

  const handleLogout = () => {
    setUserId(null)
    setIsConfiguring(true)
    localStorage.removeItem('userId')
  }

  if (isConfiguring || !userId) {
    return (
      <div className="login-page">
        <div className="login-container">
          <h1>Honmaru AI</h1>
          <p className="subtitle">Web Client (Phase 8 Reference)</p>

          <form onSubmit={handleConnect}>
            <div className="form-group">
              <label htmlFor="user-id">User ID (e.g., alice, bob):</label>
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
                placeholder="ws://localhost:8080"
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

            <button type="submit" className="connect-button">
              Connect
            </button>
          </form>

          <div className="login-info">
            <h3>Test Users</h3>
            <p>Try connecting as:</p>
            <ul>
              <li><code>alice</code></li>
              <li><code>bob</code></li>
              <li><code>charlie</code></li>
            </ul>

            <h3>Instructions</h3>
            <ol>
              <li>Start the relay: <code>cd server && npm start</code></li>
              <li>Enter a user ID (e.g., alice)</li>
              <li>Click Connect</li>
              <li>Open another browser tab, connect as a different user (e.g., bob)</li>
              <li>Send decisions between users</li>
            </ol>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="app">
      <Dashboard userId={userId} orgId={orgId} relayUrl={relayUrl} />
      <button className="logout-button" onClick={handleLogout}>
        Logout
      </button>
    </div>
  )
}

export default App
