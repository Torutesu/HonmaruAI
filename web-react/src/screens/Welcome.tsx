import React from 'react'
import { useT } from '../utils/i18n'
import './WelcomeFigma.css'
interface Props { onStart: () => void; onSignIn: () => void; onDemo: () => void }
export const Welcome: React.FC<Props> = ({ onStart, onSignIn, onDemo }) => {
  const t = useT()
  return <div className="screen figma-welcome"><main className="figma-welcome-main"><img src="/honmaru-mark.png" width="64" height="64" alt="" /><h1>{t('Welcome to')}<br />{t('Honmaru AI')}</h1><p>{t('Your AI teammate that helps you make the right decisions, every time.')}</p></main><div className="figma-welcome-actions"><button className="btn btn-primary" onClick={onStart}>{t('Get started')}</button><button className="btn btn-ghost" onClick={onSignIn}>{t('I already have an account')}</button><button className="figma-welcome-sample" onClick={onDemo}>{t('Try a local sample workspace')}</button></div></div>
}
