import React from 'react'
import { Icon, isIconName, type IconName } from './Icon'

// Stable vector symbols keep app cards readable across platforms and themes.
export function HarnessAppIcon({ icon, size = 18 }: { icon?: string; size?: number }) {
  const symbols: Record<string, IconName> = {
    '📋': 'list-check', '✅': 'list-check', '🧾': 'record', '💰': 'plan',
    '📊': 'insights', '📈': 'insights', '👥': 'users', '🤝': 'users',
    '📅': 'calendar', '🗓️': 'calendar', '📁': 'folder', '⚡': 'workflow',
  }
  const value = icon || ''
  const name = symbols[value] || (isIconName(value) ? value : 'list-check')
  return <Icon name={name} size={size} />
}
