import React from 'react'
import type { Business } from '../types/card'

interface Props {
  value: string                 // slug, or '' for none
  businesses: Business[]
  onChange: (value: string | null) => void
  label?: string
}

/// One control to file a card: the org's businesses, "none", and "new…",
/// which asks for a name and creates the business on the spot.
export const BusinessSelect: React.FC<Props> = ({ value, businesses, onChange, label }) => {
  const known = businesses.some((b) => b.slug === value)
  return (
    <label className="business-select">
      {label && <span>{label}</span>}
      <select
        value={value}
        aria-label={label || 'Business'}
        onChange={(e) => {
          const v = e.target.value
          if (v === '__new__') {
            const name = window.prompt('Name of the business')
            if (name && name.trim()) onChange(name.trim())
            return
          }
          onChange(v === '' ? null : v)
        }}
      >
        <option value="">No business</option>
        {businesses.map((b) => <option key={b.slug} value={b.slug}>{b.name}</option>)}
        {value && !known && <option value={value}>{value}</option>}
        <option value="__new__">New business…</option>
      </select>
    </label>
  )
}
