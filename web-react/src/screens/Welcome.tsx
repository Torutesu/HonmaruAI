import React from 'react'
import { useT } from '../utils/i18n'

interface Props {
  onStart: () => void
  onSignIn: () => void
}

/// The first screen. It has one job: say what happens when you open this app
/// tomorrow morning, in one sentence, and then get out of the way.
export const Welcome: React.FC<Props> = ({ onStart, onSignIn }) => {
  const t = useT()
  return (
  <div className="screen welcome">
    <div className="screen-body welcome-body">
      <div className="brandmark" aria-hidden="true">
        <span />
      </div>
      <h1 className="display welcome-display">
        {t('The decision is')}<br />{t('already waiting.')}
      </h1>
      <p className="lede">{t('welcome.lede')}</p>
      <ul className="welcome-points">
        <li><b>{t('One feed')}</b><span>{t('Everything waiting on you, most urgent first.')}</span></li>
        <li><b>{t('Ten businesses, ten people')}</b><span>{t('Every decision filed under the right one, in the background.')}</span></li>
        <li><b>{t('In your language')}</b><span>{t('Notifications arrive written in the language you read.')}</span></li>
      </ul>
    </div>
    <div className="screen-foot bare">
      <button className="btn btn-primary" onClick={onStart}>{t('Get started')}</button>
      <button className="btn btn-quiet" onClick={onSignIn}>{t('I already have an account')}</button>
    </div>
  </div>
  )
}
