import React from 'react'
import type { DecisionCard as DecisionCardType } from '../types/card'
import './DecisionCard.css'

interface Props {
  card: DecisionCardType
  currentUserId: string
  onApprove: () => void
  onDecline: () => void
  onChoose: (optionId: string) => void
  onReply: (text: string) => void
  onAcknowledge: () => void
  onRollback: () => void
  onDelegate: (userId: string) => void
  isPending: boolean
}

export const DecisionCard: React.FC<Props> = ({
  card,
  currentUserId,
  onApprove,
  onDecline,
  onChoose,
  onReply,
  onAcknowledge,
  onRollback,
  onDelegate,
  isPending
}) => {
  const isRecipient = card.recipientUserID === currentUserId
  const isRequester = card.senderUserID === currentUserId

  const getStatusColor = (): string => {
    switch (card.status) {
      case 'approved': return 'status-approved'
      case 'rejected': return 'status-rejected'
      case 'revised': return 'status-revised'
      case 'delegated': return 'status-delegated'
      case 'completed': return 'status-completed'
      default: return 'status-pending'
    }
  }

  const getPriorityColor = (): string => {
    switch (card.priority) {
      case 'low': return 'priority-low'
      case 'medium': return 'priority-medium'
      case 'high': return 'priority-high'
      case 'urgent': return 'priority-urgent'
      default: return 'priority-medium'
    }
  }

  return (
    <div className={`decision-card ${getStatusColor()}`}>
      <div className="card-header">
        <div className="card-title">{card.title}</div>
        <div className={`card-priority ${getPriorityColor()}`}>
          {card.priority.charAt(0).toUpperCase() + card.priority.slice(1)}
        </div>
      </div>

      <div className="card-summary">{card.summary}</div>

      {card.context && (
        <div className="card-context">
          <p>{card.context}</p>
        </div>
      )}

      {card.revisionNote && (
        <div className="card-revision-note">
          <strong>Revision:</strong> {card.revisionNote}
        </div>
      )}

      {card.sourceApp && (
        <div className="card-source">
          <small>From {card.sourceApp}</small>
          {card.sourceDetail && <small> • {card.sourceDetail}</small>}
        </div>
      )}

      {card.decision && (
        <div className="card-decision">
          <div className="decision-action">
            <strong>Decision:</strong> {card.decision.action}
          </div>
          {card.decision.replyText && (
            <div className="decision-text">{card.decision.replyText}</div>
          )}
          {card.decision.note && (
            <div className="decision-note">{card.decision.note}</div>
          )}
          <div className="decision-time">
            {new Date(card.decision.decidedAt).toLocaleString()}
          </div>
        </div>
      )}

      {isRecipient && card.status === 'pending' && (
        <div className="card-actions">
          <button onClick={onApprove} className="action-approve">
            Approve
          </button>
          <button onClick={onDecline} className="action-decline">
            Decline
          </button>
          <button onClick={onAcknowledge} className="action-acknowledge">
            Acknowledge
          </button>
          {card.type === 'delegation' && (
            <button onClick={() => onDelegate('user-id')} className="action-delegate">
              Re-delegate
            </button>
          )}
        </div>
      )}

      {!card.status && card.decision && (
        <div className="card-actions">
          <button onClick={onRollback} className="action-rollback">
            ↩ Roll back
          </button>
        </div>
      )}

      {card.githubIssueURL && (
        <div className="card-github-link">
          <a href={card.githubIssueURL} target="_blank" rel="noopener noreferrer">
            GitHub Issue #{card.githubIssueNumber}
          </a>
        </div>
      )}
    </div>
  )
}
