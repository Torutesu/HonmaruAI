import React, { useEffect, useMemo, useState } from 'react'
import { Sheet, SheetRow } from './Sheet'
import './PhoneDestinationComposer.css'


export type PhoneDraftDestination = { key: string; view: string; name: string; kind: string; threadId?: string; label?: string }

type Props = {
  destinations: PhoneDraftDestination[]
  api: { httpBase: string; orgId: string; sessionToken: string }
  onClose: () => void
  onChoose: (destination: PhoneDraftDestination, draft: string) => void
  t: (value: string) => string
}

export function PhoneDestinationComposer({ destinations, api, onClose, onChoose, t }: Props) {
  const [draft, setDraft] = useState('')
  const [query, setQuery] = useState('')
  const [serverSuggestions, setServerSuggestions] = useState<PhoneDraftDestination[]>([])
  useEffect(() => {
    const text = draft.trim()
    if (text.length < 2) { setServerSuggestions([]); return }
    const controller = new AbortController()
    const timer = setTimeout(async () => {
      try {
        // The existing Worker search matches a phrase as text. Search a few
        // meaningful words separately so a natural sentence can surface
        // related rooms and threads without sending it to an AI service.
        const stopWords = new Set(['about', 'after', 'also', 'and', 'are', 'can', 'could', 'for', 'from', 'have', 'help', 'into', 'please', 'that', 'the', 'this', 'to', 'with', 'would', 'you'])
        const tokens = [...new Set((text.toLocaleLowerCase().match(/[\p{L}\p{N}]{2,}/gu) || []).filter((word) => !stopWords.has(word)))]
        const rankTokens = tokens.length ? tokens : [text.toLocaleLowerCase()]
        const queries = rankTokens.slice(0, 3)
        const results = await Promise.all(queries.map(async (term) => {
          const url = new URL(`${api.httpBase}/channels/search`)
          url.searchParams.set('orgId', api.orgId)
          url.searchParams.set('q', term)
          const response = await fetch(url.toString(), { headers: { 'x-session-token': api.sessionToken }, signal: controller.signal })
          if (!response.ok) return []
          const data = await response.json()
          return Array.isArray(data?.messages) ? data.messages : []
        }))
        if (controller.signal.aborted) return
        const byView = new Map(destinations.filter((item) => item.view).map((item) => [item.view, item]))
        const found = new Map<string, { item: PhoneDraftDestination; score: number }>()
        for (const message of results.flat() as Array<{ id?: string; channel?: string; parentId?: string | null; replyCount?: number; body?: string; threadTitle?: string | null }>) {
          if (!message.id || !message.channel) continue
          const room = byView.get(message.channel)
          // Worker search is permission-scoped; require a routable room/DM too.
          if (!room) continue
          const searchable = `${room.name} ${message.threadTitle || ''} ${message.body || ''}`.toLocaleLowerCase()
          const score = rankTokens.reduce((total, word) => total + (searchable.includes(word) ? 1 : 0), 0)
          if (!score) continue
          const parent = message.parentId || ((message.replyCount || 0) > 0 ? message.id : undefined)
          if (parent) {
            const item = { ...room, threadId: parent, label: `${room.name} · ${message.threadTitle || (message.body || '').replace(/\s+/g, ' ').slice(0, 72)}` }
            const key = `thread:${room.view}:${parent}`
            const oldHit = found.get(key)
            if (!oldHit || score > oldHit.score) found.set(key, { item, score: score + 1 })
          }
          const oldRoom = found.get(room.key)
          if (!oldRoom || score > oldRoom.score) found.set(room.key, { item: room, score })
        }
        setServerSuggestions([...found.values()].sort((a, b) => b.score - a.score || Number(Boolean(b.item.threadId)) - Number(Boolean(a.item.threadId)) || (a.item.label || a.item.name).localeCompare(b.item.label || b.item.name)).slice(0, 8).map(({ item }) => item))
      } catch { if (!controller.signal.aborted) setServerSuggestions([]) }
    }, 250)
    return () => { controller.abort(); clearTimeout(timer) }
  }, [draft, api.httpBase, api.orgId, api.sessionToken, destinations])
  const suggestions = useMemo(() => {
    const terms = query.toLocaleLowerCase().split(/\s+/).filter(Boolean)
    const local = destinations.filter((destination) => !terms.length || terms.some((term) => destination.name.toLocaleLowerCase().includes(term)))
    const all = [...serverSuggestions, ...local]
    return [...new Map(all.map((item) => [item.threadId ? `thread:${item.view}:${item.threadId}` : item.key, item])).values()].slice(0, 8)
  }, [destinations, query, serverSuggestions])

  return (
    <Sheet label={t('Draft a message')} onClose={onClose} className="phone-destination-sheet">
      <header className="phone-destination-head"><h2>{t('Draft a message')}</h2><button type="button" onClick={onClose} aria-label={t('Close')}>×</button></header>
      <label className="phone-destination-label" htmlFor="phone-draft-message">{t('What would you like to say?')}</label>
      <textarea className="phone-destination-field" id="phone-draft-message" value={draft} onChange={(event) => setDraft(event.target.value)} rows={4} autoFocus />
      <label className="phone-destination-label" htmlFor="phone-draft-destination">{t('Choose a destination')}</label>
      <input className="phone-destination-field" id="phone-draft-destination" value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t('Search conversations and rooms')} />
      <p className="phone-destination-note">{t('Choosing opens a saved draft. Nothing is sent until you send it.')}</p>
      <div className="msheet-rows" role="list" aria-label={t('Available destinations')}>
        {suggestions.map((destination) => (
          <SheetRow key={destination.threadId ? `thread:${destination.view}:${destination.threadId}` : destination.key} icon={destination.kind === 'channel' ? 'hash' : 'message'} label={destination.label || destination.name} onClick={() => onChoose(destination, draft)} data="draft-destination" />
        ))}
        {!suggestions.length && <p role="status">{t('No matching conversations or rooms')}</p>}
      </div>
      <footer className="phone-destination-actions"><button type="button" onClick={onClose}>{t('Cancel')}</button></footer>
    </Sheet>
  )
}
