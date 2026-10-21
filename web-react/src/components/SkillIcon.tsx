import React from 'react'
import { Icon, type IconName } from './Icon'
import type { Skill } from '../utils/harness'

// Local vector assets only. Imported metadata cannot load remote images or SVG.
const icons: Record<string, IconName> = {
  book: 'book', file: 'file', chart: 'file-chart', palette: 'palette', globe: 'globe',
  grid: 'grid', plug: 'plug', rocket: 'rocket', mail: 'mail', workflow: 'workflow',
  sparkle: 'sparkle', 'map-pin': 'map-pin', monitor: 'monitor', terminal: 'terminal',
  image: 'image', users: 'users', search: 'search', code: 'code', calendar: 'calendar',
  shield: 'shield', folder: 'folder', video: 'video', mic: 'mic',
}
const names: Record<string, IconName> = {
  artifact: 'file-chart', 'brand-system': 'palette', 'browser-use': 'globe',
  'build-app': 'grid', connections: 'plug', 'deploy-app': 'rocket',
  'email-processor': 'mail', 'event-automation': 'workflow', 'file-understanding': 'sparkle',
  goplaces: 'map-pin', 'html-slides': 'monitor', 'media-generation': 'image',
  'people-company-data': 'users', 'seo-research': 'search', 'skill-management': 'book',
}
export function skillType(skill: Skill): string {
  const value = skill.metadata?.type
  return typeof value === 'string' ? value.trim().slice(0, 80) : ''
}
export function SkillIcon({ skill }: { skill: Skill }) {
  const requested = skill.metadata?.icon
  const explicit = typeof requested === 'string' && Object.hasOwn(icons, requested) ? icons[requested] : undefined
  const name = skill.name.trim().toLowerCase()
  const icon = explicit || (Object.hasOwn(names, name) ? names[name] : 'book')
  return <span className="hx-skill-symbol" data-icon={icon}><Icon name={icon} size={19}/></span>
}
