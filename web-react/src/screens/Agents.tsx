import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { AgentAvatar } from '../components/AgentAvatar'
import { useT } from '../utils/i18n'
import { getLocale } from '../utils/locale'
import { Markdown } from '../utils/markdown'
import { Dialog } from '../components/Dialog'
import {
  agentError, agentFileName, blankDraft, draftFromAgent, draftFromPreset, parseAgentFile, MAX_INSTRUCTIONS,
} from '../utils/agents'
import type { AgentDraft, AgentPreset, ClientAgent } from '../utils/agents'

interface Props {
  httpBase: string
  orgId: string
  sessionToken: string
  onClose: () => void
  /// Open a conversation with this agent, as with a teammate.
  onMessage?: (agentId: string) => void
}

/// Tell the conversations the list changed: "@" offers the new names.
const announce = () => { try { window.dispatchEvent(new Event('honmaru:agents-changed')) } catch { /* nothing listening */ } }

/// The team's agents: teammates that are instructions. "@hayao" in any
/// conversation, and Hayao answers in the thread under the message, as its
/// Markdown says. A team agent is everyone's to call and improve; a
/// personal one answers only whoever made it. Each is a .md file, to
/// download and bring back here or into another workspace.
export const Agents: React.FC<Props> = ({ httpBase, orgId, sessionToken, onClose, onMessage }) => {
  const t = useT()
  const [privateCreation, setPrivateCreation] = useState(false)
  const [agents, setAgents] = useState<ClientAgent[] | null>(null)
  const [presets, setPresets] = useState<AgentPreset[]>([])
  const [error, setError] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [draft, setDraft] = useState<AgentDraft | null>(null)
  const [draftError, setDraftError] = useState<string | null>(null)
  const [preview, setPreview] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirm, setConfirm] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement>(null)
  // The picture chosen in the editor, kept until Save; or "take it off".
  const [picture, setPicture] = useState<{ file: File; url: string } | null>(null)
  const [pictureOff, setPictureOff] = useState(false)
  const pictureInput = useRef<HTMLInputElement>(null)
  useEffect(() => () => { if (picture) URL.revokeObjectURL(picture.url) }, [picture])

  const headers = useMemo(() => ({ 'content-type': 'application/json', 'x-session-token': sessionToken }), [sessionToken])
  const load = useCallback(async () => {
    try {
      const res = await fetch(`${httpBase}/channels/agents?orgId=${encodeURIComponent(orgId)}&locale=${encodeURIComponent(getLocale())}`, { headers: { 'x-session-token': sessionToken } })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || t('Could not load the agents.'))
      setAgents(data.agents || [])
      setPresets(data.presets || [])
      setPrivateCreation(data.privateCreation === true)
    } catch (err) {
      setAgents([])
      setError(err instanceof Error ? agentError(err.message, t) : String(err))
    }
  }, [httpBase, orgId, sessionToken, t])
  useEffect(() => { void load() }, [load])

  const send = async (method: string, body: Record<string, unknown>) => {
    const res = await fetch(`${httpBase}/channels/agents`, { method, headers, body: JSON.stringify({ orgId, ...body }) })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw Object.assign(new Error(agentError(data.message || '', t)), { status: res.status })
    if (Array.isArray(data.agents)) setAgents(data.agents)
    announce()
    return data
  }

  const open = (next: AgentDraft) => { setDraft(!next.id && privateCreation ? { ...next, scope: 'personal', canChangeScope: false } : next); setDraftError(null); setPreview(false); setConfirm(null); setNote(null); setPicture(null); setPictureOff(false) }
  /// A picture for the agent, in place of its emoji: an image of 2 MB at
  /// most — the same as a person's photo. Not SVG: it could run script.
  const PICTURE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']
  const choosePicture = (file: File) => {
    if (!PICTURE_TYPES.includes(file.type)) { setDraftError(t('A picture is a PNG, JPEG, WebP or GIF.')); return }
    if (file.size > 2 * 1024 * 1024) { setDraftError(t('A picture is at most 2 MB.')); return }
    setDraftError(null); setPictureOff(false)
    setPicture({ file, url: URL.createObjectURL(file) })
  }
  /// Sent once the agent is saved: a new one has no id before then.
  const savePicture = async (id: string) => {
    const at = `${httpBase}/channels/agents/avatar?orgId=${encodeURIComponent(orgId)}&id=${encodeURIComponent(id)}`
    const res = picture
      ? await fetch(at, { method: 'POST', headers: { 'x-session-token': sessionToken, 'content-type': picture.file.type }, body: picture.file })
      : await fetch(at, { method: 'DELETE', headers: { 'x-session-token': sessionToken } })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(agentError(data.message || '', t))
  }
  const save = async () => {
    if (!draft || saving) return
    setSaving(true); setDraftError(null)
    try {
      const fields = {
        name: draft.name.trim(), handle: draft.handle.trim().replace(/^[@＠]+/, ''), emoji: draft.emoji.trim(),
        description: draft.description.trim(), instructions: draft.instructions, scope: draft.scope,
      }
      const data = draft.id
        ? await send('PUT', { id: draft.id, ...fields })
        : await send('POST', { ...fields, ...(draft.preset ? { preset: draft.preset } : {}) })
      const a = data.agent as ClientAgent | undefined
      if (a && (picture || (pictureOff && draft.avatarUrl))) {
        try {
          await savePicture(a.id)
          await load()
          announce()
        } catch (err) {
          // The agent is saved; only its picture is not. Say so, and stay.
          setDraft({ ...draftFromAgent(a), avatarUrl: a.avatarUrl || null })
          setDraftError(t('Saved, but the picture did not upload: {why}', { why: err instanceof Error ? err.message : String(err) }))
          return
        }
      }
      setDraft(null)
      if (a) setNote(t('Saved. Write @{handle} in any conversation to call it.', { handle: a.handle }))
    } catch (err) {
      setDraftError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }
  const remove = async (a: ClientAgent) => {
    setBusy(a.id); setError(null); setNote(null)
    try {
      await send('DELETE', { id: a.id })
      setConfirm(null)
      setNote(t('Deleted @{handle}. What it wrote stays.', { handle: a.handle }))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }
  /// A .md file: straight in when it can be; into the editor when the
  /// server wants something changed first (its @name is taken, say).
  const importFile = async (file: File) => {
    setError(null); setNote(null)
    let text = ''
    try { text = await file.text() } catch { setError(t('Could not read that file.')); return }
    if (!text.trim()) { setError(t('That file is empty.')); return }
    setBusy('import')
    try {
      const data = await send('POST', { markdown: text })
      const a = data.agent as ClientAgent | undefined
      if (a) setNote(t('Imported @{handle}.', { handle: a.handle }))
    } catch (err) {
      const status = (err as { status?: number }).status
      if (status === 400 || status === 409) {
        open(parseAgentFile(text))
        setDraftError(err instanceof Error ? err.message : String(err))
      } else setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(null)
    }
  }
  const download = (a: ClientAgent) => {
    const url = URL.createObjectURL(new Blob([a.markdown], { type: 'text/markdown;charset=utf-8' }))
    const link = document.createElement('a')
    link.href = url
    link.download = agentFileName(a.handle)
    document.body.appendChild(link)
    link.click()
    link.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
  }

  const date = (iso: string) => (iso ? new Date(iso).toLocaleDateString(getLocale(), { month: 'short', day: 'numeric' }) : '')
  const team = (agents || []).filter((a) => a.scope === 'team')
  const mine = (agents || []).filter((a) => a.scope === 'personal')
  const added = new Set((agents || []).map((a) => a.preset).filter(Boolean))

  const row = (a: ClientAgent) => (
    <div className="row static ca-row" key={a.id} data-agent={a.id} data-agent-handle={a.handle}>
      <AgentAvatar className="ca-face" agent={a} />
      <span className="row-main">
        <span className="ca-name">{a.name} <span className="ca-handle">@{a.handle}</span></span>
        {a.description && <span className="ca-desc">{a.description}</span>}
        <span className="row-sub">
          {a.updatedByName && a.updatedByName !== a.createdByName
            ? t('Edited by {name}', { name: a.updatedByName })
            : a.mine ? t('Made by you') : t('Made by {name}', { name: a.createdByName || t('a teammate') })}
          {a.updatedAt ? ` · ${date(a.updatedAt)}` : ''}
        </span>
        <span className="routine-actions">
          {confirm === a.id ? (
            <span className="team-confirm">
              <span className="routine-ask">{t('Delete @{handle}?', { handle: a.handle })}</span>
              <button className="pill-btn" disabled={busy === a.id} onClick={() => void remove(a)}>{t('Delete')}</button>
              <button className="btn-text" onClick={() => setConfirm(null)}>{t('Keep')}</button>
            </span>
          ) : (
            <>
              {onMessage && <button className="btn-text ca-message" data-message-agent={a.id} onClick={() => onMessage(a.id)}>{t('Message')}</button>}
              {a.canEdit && <button className="btn-text" onClick={() => open(draftFromAgent(a))}>{t('Edit')}</button>}
              <button className="btn-text" onClick={() => download(a)}>{t('Download .md')}</button>
              {a.canDelete && <button className="btn-text danger" onClick={() => { setConfirm(a.id); setNote(null) }}>{t('Delete')}</button>}
            </>
          )}
        </span>
      </span>
    </div>
  )

  return (
    <div className="screen ca-screen">
      <div className="screen-head">
        <button className="back" onClick={onClose} aria-label={t('Close')}>‹</button>
        <span className="head-title">{t('Agents')}</span>
      </div>
      <div className="screen-body">
        <p className="lede" style={{ marginTop: 8 }}>
          {t('Teammates your team writes in Markdown. Write @handle in any conversation and the agent answers in the thread under your message.')}
          {' '}{t('Or message one directly: it answers you there, with your past decisions and connected tools at hand.')}
        </p>

        <div className="ca-actions">
          <button className="pill-btn" onClick={() => open(blankDraft())}>{t('New agent')}</button>
          <button className="pill-btn quiet" disabled={busy === 'import'} onClick={() => fileInput.current?.click()}>{t('Import .md')}</button>
          <input
            ref={fileInput}
            type="file"
            accept=".md,text/markdown,text/plain"
            className="ca-file"
            aria-label={t('Import .md')}
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void importFile(f) }}
          />
        </div>

        {note && <div className="form-note" role="status">{note}</div>}
        {error && <div className="form-error">{error}</div>}

        <div className="rows-title">{t('Your team’s agents')}</div>
        {agents === null && <div className="empty">{t('Loading…')}</div>}
        {agents !== null && (
          <div className="rows ca-list" data-scope="team">
            {team.length === 0
              ? <div className="row static"><span className="row-main"><span className="row-sub">{t('None yet. Add one from a preset below, or write your own.')}</span></span></div>
              : team.map(row)}
          </div>
        )}

        {agents !== null && (
          <>
            <div className="rows-title">{t('Only you')}</div>
            <div className="rows ca-list" data-scope="personal">
              {mine.length === 0
                ? <div className="row static"><span className="row-main"><span className="row-sub">{t('Agents only you can call. Choose “Only me” when you make one.')}</span></span></div>
                : mine.map(row)}
            </div>
          </>
        )}

        {presets.length > 0 && (
          <>
            <div className="rows-title">{t('Start from a preset')}</div>
            <div className="ca-presets">
              {presets.map((p) => (
                <div className="ca-preset" key={p.id} data-preset={p.id}>
                  <span className="ca-face" aria-hidden="true">{p.emoji}</span>
                  <span className="ca-preset-text">
                    <span className="ca-name">{p.name} <span className="ca-handle">@{p.handle}</span></span>
                    <span className="ca-desc">{p.description}</span>
                  </span>
                  <button className="pill-btn quiet" onClick={() => open(draftFromPreset(p))}>
                    {added.has(p.id) ? t('Add again') : t('Add')}
                  </button>
                </div>
              ))}
            </div>
          </>
        )}
        <div style={{ height: 24 }} />
      </div>

      {draft && (
        <Dialog
          title={draft.id ? t('Edit @{handle}', { handle: draft.handle }) : t('New agent')}
          lede={t('Its instructions are Markdown: who it is, what it does and how it answers.')}
          className="ca-dialog"
          onClose={() => setDraft(null)}
          footer={(
            <>
              <button type="button" className="dlg-btn" onClick={() => setDraft(null)}>{t('Cancel')}</button>
              <button type="button" className="dlg-btn primary ca-save" disabled={saving || !draft.name.trim() || !draft.instructions.trim()} onClick={() => void save()}>
                {saving ? t('Saving…') : t('Save')}
              </button>
            </>
          )}
        >
          <div className="ca-grid">
            <div className="ca-field ca-emoji-field">
              <span className="dlg-label">{t('Icon')}</span>
              {(() => {
                const shown = picture?.url || (pictureOff ? null : draft.avatarUrl)
                return shown ? (
                  <button type="button" className="ca-picture" data-agent-picture onClick={() => pictureInput.current?.click()} aria-label={t('Change the picture')} title={t('Change the picture')}>
                    <img src={shown} alt="" />
                  </button>
                ) : (
                  <input className="dlg-input ca-emoji" value={draft.emoji} maxLength={16} placeholder="🤖"
                    onChange={(e) => setDraft({ ...draft, emoji: e.target.value })} aria-label={t('Emoji')} />
                )
              })()}
              <span className="ca-picture-actions">
                <button type="button" className="btn-text" data-agent-picture-pick onClick={() => pictureInput.current?.click()}>
                  {picture || (draft.avatarUrl && !pictureOff) ? t('Change') : t('Picture…')}
                </button>
                {(picture || (draft.avatarUrl && !pictureOff)) && (
                  <button type="button" className="btn-text" data-agent-picture-remove onClick={() => { setPicture(null); setPictureOff(true) }}>{t('Use emoji')}</button>
                )}
              </span>
              <input ref={pictureInput} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="ca-file" data-agent-picture-input
                aria-label={t('Picture…')} onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) choosePicture(f) }} />
            </div>
            <label className="ca-field">
              <span className="dlg-label">{t('Name')}</span>
              <input className="dlg-input ca-name-input" value={draft.name} maxLength={40} placeholder={t('e.g. Hayao')}
                onChange={(e) => setDraft({ ...draft, name: e.target.value })} aria-label={t('Name')} />
            </label>
            <label className="ca-field">
              <span className="dlg-label">{t('@name')}</span>
              <span className="ca-handle-field">
                <span className="ca-at" aria-hidden="true">@</span>
                <input className="dlg-input ca-handle-input" value={draft.handle} maxLength={30} placeholder="hayao"
                  autoCapitalize="off" autoCorrect="off" spellCheck={false}
                  onChange={(e) => setDraft({ ...draft, handle: e.target.value.replace(/^[@＠]+/, '').replace(/\s+/g, '') })} aria-label={t('@name')} />
              </span>
            </label>
          </div>
          <label className="ca-field">
            <span className="dlg-label">{t('Description')} <span className="dlg-optional">{t('(optional)')}</span></span>
            <input className="dlg-input ca-desc-input" value={draft.description} maxLength={200} placeholder={t('What it is for, in one line.')}
              onChange={(e) => setDraft({ ...draft, description: e.target.value })} aria-label={t('Description')} />
          </label>
          <div className="ca-field">
            <span className="dlg-label">{t('Who can call it')}</span>
            <div className="ca-scope" role="group" aria-label={t('Who can call it')}>
              {(['team', 'personal'] as const).map((s) => (
                <button key={s} type="button" data-scope={s} aria-pressed={draft.scope === s}
                  className={draft.scope === s ? 'on' : ''} disabled={!draft.canChangeScope}
                  onClick={() => setDraft({ ...draft, scope: s })}>
                  {s === 'team' ? t('Everyone on the team') : t('Only me')}
                </button>
              ))}
            </div>
            <p className="dlg-hint">
              {draft.scope === 'team'
                ? t('Anyone on the team can call it and improve its instructions.')
                : t('Only you can call it, see it and change it.')}
            </p>
          </div>
          <div className="ca-field">
            <span className="ca-instr-head">
              <span className="dlg-label">{t('Instructions')}</span>
              <span className="ca-tabs" role="tablist">
                <button type="button" role="tab" aria-selected={!preview} className={!preview ? 'on' : ''} onClick={() => setPreview(false)}>{t('Write')}</button>
                <button type="button" role="tab" aria-selected={preview} className={preview ? 'on' : ''} onClick={() => setPreview(true)}>{t('Preview')}</button>
              </span>
            </span>
            {preview ? (
              <div className="ca-preview">
                {draft.instructions.trim() ? <Markdown source={draft.instructions} className="ca-md" /> : <p className="dlg-note">{t('Nothing written yet.')}</p>}
              </div>
            ) : (
              <textarea
                className="dlg-input ca-instructions"
                value={draft.instructions}
                maxLength={MAX_INSTRUCTIONS}
                rows={14}
                spellCheck={false}
                placeholder={t('Who it is, what it does and how it answers. Markdown works: # headings, - lists, **bold**.')}
                onChange={(e) => setDraft({ ...draft, instructions: e.target.value })}
                aria-label={t('Instructions')}
              />
            )}
            <p className="dlg-hint">
              {t('It also reads the conversation it was called into and your team’s playbook. It writes; it does not act.')}
              {draft.instructions.length > MAX_INSTRUCTIONS - 2000 ? ` ${draft.instructions.length}/${MAX_INSTRUCTIONS}` : ''}
            </p>
          </div>
          {draftError && <p className="dlg-error" role="alert">{draftError}</p>}
        </Dialog>
      )}
    </div>
  )
}
