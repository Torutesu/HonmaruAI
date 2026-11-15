const LEGACY_FONT_TYPES = new Set([
  'application/font-sfnt',
  'application/font-woff',
  'application/font-woff2',
  'application/vnd.ms-fontobject',
  'application/vnd.ms-opentype',
  'application/x-font-otf',
  'application/x-font-opentype',
  'application/x-font-sfnt',
  'application/x-font-truetype',
  'application/x-font-ttf',
  'application/x-font-woff',
  'application/x-font-woff2',
])

/** Return a normalized MIME type that can be published as a download. */
export function publicFileType(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const type = value.split(';', 1)[0].trim().toLowerCase()
  if (!/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(type)) return null
  return type
}

/** Return a normalized type only when it is safe for inline public display. */
export function publicMediaType(value: unknown): string | null {
  const type = publicFileType(value)
  if (!type) return null
  if (LEGACY_FONT_TYPES.has(type)) return type
  const category = type.slice(0, type.indexOf('/'))
  return category === 'image' || category === 'video' || category === 'audio' || category === 'font'
    ? type
    : null
}
