/** Match Room names exactly or tolerate one missing, extra, or mistyped letter.
 * Short queries stay exact so a broad one-letter guess cannot surface unrelated Rooms.
 */
export function roomNameMatches(query: string, name: string): boolean {
  const needle = query.trim().normalize('NFKC').toLocaleLowerCase()
  const haystack = name.normalize('NFKC').toLocaleLowerCase()
  if (!needle) return true
  if (haystack.includes(needle)) return true
  const wanted = Array.from(needle)
  const candidate = Array.from(haystack)
  if (wanted.length < 4 || wanted.length > 80 || candidate.length > 160) return false

  // Approximate substring Levenshtein distance: the zero-cost first row lets
  // the query match any part of a multiword Room name without a fuzzy index.
  let previous = new Array<number>(candidate.length + 1).fill(0)
  for (let i = 1; i <= wanted.length; i++) {
    const current = new Array<number>(candidate.length + 1)
    current[0] = i
    for (let j = 1; j <= candidate.length; j++) {
      const substitution = previous[j - 1] + (wanted[i - 1] === candidate[j - 1] ? 0 : 1)
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, substitution)
    }
    previous = current
  }
  return previous.some(distance => distance <= 1)
}
