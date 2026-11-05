import React from 'react'
import { useT } from '../utils/i18n'

export const AppDeleteConfirm: React.FC<{ onDelete: () => void; onKeep: () => void }> = ({ onDelete, onKeep }) => {
  const t = useT()
  return (
    <div className="row static" role="group" aria-label={t('Delete app confirmation')}>
      <span className="row-main">
        {t('Delete this app?')}
        <span className="row-sub">{t('This app will be hidden. Its database and data will remain until the workspace is deleted.')}</span>
      </span>
      <span className="team-confirm">
        <button className="pill-btn" onClick={onDelete}>{t('Delete')}</button>
        <button className="btn-text" onClick={onKeep}>{t('Keep')}</button>
      </span>
    </div>
  )
}
