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
  highlighted?: boolean
  businessName?: string
}

// The relay stores a version of a new card in the recipient's language under
// `localized[locale]`. Read it in the browser's language when there is one.
function readerLocale(): string {
  return (typeof navigator !== 'undefined' ? navigator.language : 'en').toLowerCase().split(/[-_]/)[0]
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
  isPending,
  highlighted = false,
  businessName
}) => {
  const isRecipient = card.recipientUserID === currentUserId
  const isRequester = card.senderUserID === currentUserId
  const localized = card.localized?.[readerLocale()]
  const title = localized?.title || card.title
  const summary = localized?.summary || card.summary
  const context = localized?.context || card.context

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
    <div id={`card-${card.id}`} className={`decision-card ${getStatusColor()}${highlighted ? ' card-highlight' : ''}`}>
      <div className="card-header">
        <div className="card-title">{title}</div>
        <div className={`card-priority ${getPriorityColor()}`}>
          {card.priority.charAt(0).toUpperCase() + card.priority.slice(1)}
        </div>
      </div>

      {card.business && (
        <div className="card-business"><span className="business-tag">{businessName || card.business}</span></div>
      )}

      <div className="card-summary">{summary}</div>

      {context && (
        <div className="card-context">
          <p>{context}</p>
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
