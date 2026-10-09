/// One `Intl.DateTimeFormat` per locale and set of options, made once and
/// kept. `Date#toLocaleString(locale, options)` builds a new formatter on
/// every call, and building one is the expensive part: a conversation drew
/// two of them per message, every time it was drawn, which was most of the
/// time a long channel took to draw (each keystroke in its box redrew it).
const made = new Map<string, Intl.DateTimeFormat>()

export function dateFormat(locale: string | readonly string[] | undefined, options: Intl.DateTimeFormatOptions): Intl.DateTimeFormat {
  const key = `${Array.isArray(locale) ? locale.join(',') : locale ?? ''}|${JSON.stringify(options)}`
  let f = made.get(key)
  if (!f) {
    f = new Intl.DateTimeFormat(locale as string | string[] | undefined, options)
    made.set(key, f)
  }
  return f
}

/// `date.toLocaleString(locale, options)`, through a kept formatter. The
/// same words: given its fields (or a date or time style), toLocaleString,
/// toLocaleDateString and toLocaleTimeString add none of their own.
export function formatDate(date: Date | number, locale: string | readonly string[] | undefined, options: Intl.DateTimeFormatOptions): string {
  // A formatter throws on a date that is not one; toLocaleString says so.
  if (!Number.isFinite(+date)) return 'Invalid Date'
  return dateFormat(locale, options).format(date)
}
