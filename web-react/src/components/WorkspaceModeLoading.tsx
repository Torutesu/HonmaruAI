import React from 'react'
import {useT} from '../utils/i18n'
import './WorkspaceModeLoading.css'
export function WorkspaceModeLoading({error,onRetry,onSimple}:{error:string;onRetry:()=>void;onSimple:()=>void}){
 const t=useT()
 return <main className="workspace-mode-loading"><div role={error?'alert':'status'}><p>{t(error?'Workspace settings could not load.':'Loading workspace…')}</p>{error&&<div className="workspace-mode-loading-actions"><button onClick={onRetry}>{t('Retry')}</button><button onClick={onSimple}>{t('Use only Simple in this browser')}</button></div>}</div></main>
}
