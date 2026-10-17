import React from 'react'
import { Icon, type IconName } from './Icon'

// Stable vector symbols keep app cards readable across platforms and themes.
export function HarnessAppIcon({ icon, size = 18 }: { icon?: string; size?: number }) {
  const symbols: Record<string, IconName> = {
    '📋': 'list-check', '✅': 'list-check', '🧾': 'record', '💰': 'plan',
    '📊': 'insights', '📈': 'insights', '👥': 'users', '🤝': 'users',
    '📅': 'calendar', '🗓️': 'calendar', '📁': 'folder', '⚡': 'workflow',
  }
  return <Icon name={symbols[icon || ''] || 'list-check'} size={size} />
}
