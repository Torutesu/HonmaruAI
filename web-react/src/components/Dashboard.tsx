import React, { useState, useEffect, useCallback } from 'react'
import { WebSocketClient } from '../services/WebSocketClient'
import { DecisionCard } from './DecisionCard'
import { CreateDecision } from './CreateDecision'
import { InviteTeammate } from './InviteTeammate'
import type { AppState, DecisionCard as DecisionCardType } from '../types/card'
import './Dashboard.css'

interface Props {
  userId: string
  orgId: string
  relayUrl: string
  sessionToken: string
}

export const Dashboard: React.FC<Props> = ({ userId, orgId, relayUrl, sessionToken }) => {
  const [state, setState] = useState<AppState>({ cardsById: {} })
  const [isConnected, setIsConnected] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [showDebugLog, setShowDebugLog] = useState(import.meta.env.VITE_DEBUG === 'true')
  const [debugLog, setDebugLog] = useState<Array<{ timestamp: string; message: string }>>([])

  const wsClientRef = React.useRef<WebSocketClient | null>(null)
  if (wsClientRef.current === null) {
    wsClientRef.current = new WebSocketClient()
  }

  const addDebugLog = useCallback((message: string) => {
    const now = new Date().toLocaleTimeString()
    setDebugLog(logs => [...logs, { timestamp: now, message }])
  }, [])

  useEffect(() => {
    const wsClient = wsClientRef.current!
    let ignore = false

    wsClient.onStateChange = (newState) => {
      if (ignore) return
      setState(newState)
      addDebugLog(`State updated: ${Object.keys(newState.cardsById).length} cards`)
    }

    wsClient.onCardCreated = (card) => {
      if (!ignore) addDebugLog(`Card created: ${card.id}`)
    }

    wsClient.onCardUpdated = (card) => {
      if (!ignore) addDebugLog(`Card updated: ${card.id}`)
    }

    wsClient.onCardDeleted = (cardId) => {
      if (!ignore) addDebugLog(`Card deleted: ${cardId}`)
    }

    wsClient.onPresence = (userId, status) => {
      if (!ignore) addDebugLog(`Presence: ${userId} → ${status}`)
    }

    wsClient.onError = (message) => {
      if (ignore) return
      setError(message)
      addDebugLog(`Error: ${message}`)
    }

    wsClient.onToolCallResult = (toolCallId) => {
      if (!ignore) addDebugLog(`Tool result: ${toolCallId}`)
    }

    wsClient.onConnectionChange = (connected) => {
      if (ignore) return
      setIsConnected(connected)
      addDebugLog(connected ? `Connected to ${relayUrl}` : 'Disconnected — will retry')
    }

    const connect = async () => {
      try {
        await wsClient.connect(relayUrl, userId, orgId, sessionToken)
      } catch (err) {
        if (ignore) return
        const message = err instanceof Error ? err.message : String(err)
        setError(`Failed to connect: ${message}`)
        addDebugLog(`Connection failed: ${message}`)
      }
    }

    connect()

    return () => {
      ignore = true
      wsClient.disconnect()
    }
  }, [relayUrl, userId, orgId, sessionToken, addDebugLog])

  const handleDecision = useCallback(
    (cardId: string, action: string, options?: any) => {
      wsClientRef.current!.sendDecision(cardId, action, options)
      addDebugLog(`Sent decision: ${cardId} → ${action}`)
    },
    [addDebugLog]
  )

  const handleRollback = useCallback(
    (cardId: string) => {
      wsClientRef.current!.sendRollback(cardId)
      addDebugLog(`Rolled back: ${cardId}`)
    },
    [addDebugLog]
  )

    const handleNudge = useCallback(
    (cardId: string) => {
      wsClientRef.current!.sendNudge(cardId)
      addDebugLog(`Nudged: ${cardId}`)
    },
    [addDebugLog]
  )
// /ai/route is an HTTP call; the relay URL is a WebSocket URL. Convert
  // ws://host -> http://host and wss://host -> https://host.
  const relayHttpUrl = relayUrl.replace(/^ws/, 'http')
  
  
    const cards = Object.values(state.cardsById || {})
  // To me, still waiting on my decision.
  const pendingCards = cards.filter(c => c.status === 'pending' && c.recipientUserID === userId)
  // Decisions I was the recipient of and have already acted on.
  const decidedCards = cards.filter(c => c.recipientUserID === userId && (c.status !== 'pending' || c.decision))
  // Things I sent to someone else — so I can see if they're still waiting.
  const sentCards = cards.filter(c => c.senderUserID === userId && c.recipientUserID !== userId)

  return (
    <div className="dashboard">
      <div className="dashboard-header">
        <h1>Honmaru Decision Feed</h1>
        <div className="status-bar">
          <span className={`status-indicator ${isConnected ? 'connected' : 'disconnected'}`}>
            {isConnected ? '● Connected' : '● Disconnected'}
          </span>
          <span className="user-info">{userId}</span>
          <span className="org-info">{orgId}</span>
        </div>
      </div>

      {error && (
        <div className="error-banner">
          <strong>Error:</strong> {error}
        </div>
      )}

            <div className="dashboard-content">
        <div className="main-feed">
       <CreateDecision
            relayHttpUrl={relayHttpUrl}
            orgId={orgId}
            userId={userId}
            sessionToken={sessionToken}
            onSendCard={(card) => wsClientRef.current!.sendCardCreated(card)}
            onLog={(msg) => addDebugLog(msg)}
          />

          <div className="section">
            <h2 className="section-title">
              Pending Decisions ({pendingCards.length})
            </h2>
            {pendingCards.length === 0 ? (
              <div className="empty-state">
                <p>No pending decisions. You're all caught up!</p>
              </div>
            ) : (
              <div className="cards-list">
                {pendingCards.map((card) => (
                  <DecisionCard
                    key={card.id}
                    card={card}
                    currentUserId={userId}
                    onApprove={() => handleDecision(card.id, 'approve')}
                    onDecline={() => handleDecision(card.id, 'decline')}
                    onChoose={(optionId) => handleDecision(card.id, 'choose', { optionId })}
                    onReply={(text) => handleDecision(card.id, 'reply', { replyText: text })}
                    onAcknowledge={() => handleDecision(card.id, 'acknowledge')}
                    onRollback={() => handleRollback(card.id)}
                    onDelegate={() => handleDecision(card.id, 'delegate')}
                    isPending={true}
                  />
                ))}
              </div>
            )}
          </div>

                    <div className="section">
            <h2 className="section-title">Sent by you ({sentCards.length})</h2>
            {sentCards.length === 0 ? (
              <div className="empty-state">
                <p>You haven't sent any decisions yet.</p>
              </div>
            ) : (
              <div className="cards-list">
                {sentCards.map((card) => (
                  <div key={card.id} className="sent-card">
                    <div className="sent-card-head">
                      <strong>{card.title}</strong>
                      <span className={`sent-status ${card.status === 'pending' ? 'waiting' : 'done'}`}>
                        {card.status === 'pending'
                          ? `Waiting on ${card.recipientUserID.replace(/^email:/, '').split('@')[0]}`
                          : `${card.decision?.action || 'decided'}`}
                      </span>
                    </div>
                    <p className="sent-summary">{card.summary}</p>
                    {card.status === 'pending' && (
                      <button
                        className="nudge-button"
                        onClick={() => handleNudge(card.id)}
                      >
                        Nudge
                      </button>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>

          <div className="section">
            <h2 className="section-title">Decided ({decidedCards.length})</h2>
            {decidedCards.length === 0 ? (
              <div className="empty-state">
                <p>No decisions made yet.</p>
              </div>
            ) : (
              <div className="cards-list">
                {decidedCards.map((card) => (
                  <DecisionCard
                    key={card.id}
                    card={card}
                    currentUserId={userId}
                    onApprove={() => {}}
                    onDecline={() => {}}
                    onChoose={() => {}}
                    onReply={() => {}}
                    onAcknowledge={() => {}}
                    onRollback={() => handleRollback(card.id)}
                    onDelegate={() => {}}
                    isPending={false}
                  />
                ))}
              </div>
            )}
          </div>
        </div>

        <div className="sidebar">
          <button
            className="debug-toggle"
            onClick={() => setShowDebugLog(!showDebugLog)}
          >
            {showDebugLog ? 'Hide' : 'Show'} Debug Log
          </button>

          {showDebugLog && (
            <div className="debug-log">
              <h3>Event Log</h3>
              <div className="log-entries">
                {debugLog.map((entry, i) => (
                  <div key={i} className="log-entry">
                    <span className="log-time">{entry.timestamp}</span>
                    <span className="log-message">{entry.message}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
            <InviteTeammate
            relayHttpUrl={relayHttpUrl}
            orgId={orgId}
            sessionToken={sessionToken}
          />
      <div className="info-panel">
            <h3>Connection Info</h3>
            <ul>
              <li><strong>URL:</strong> {relayUrl}</li>
              <li><strong>User ID:</strong> {userId}</li>
              <li><strong>Org ID:</strong> {orgId}</li>
              <li><strong>Total Cards:</strong> {cards.length}</li>
              <li><strong>Pending:</strong> {pendingCards.length}</li>
              <li><strong>Decided:</strong> {decidedCards.length}</li>
            </ul>
          </div>
        </div>
      </div>
    </div>
  )
}