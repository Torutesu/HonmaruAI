import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useT } from '../utils/i18n'
import { Icon } from './Icon'
import { Avatar } from './Avatar'
import { JAM_REACTIONS, audioDevices, canShareScreen, canTranscribe, type JamCall, type JamParticipant } from '../utils/jam'
import type { ChannelMessage } from '../types/card'
import './JamPanel.css'

interface Props {
  call: JamCall
  /// The channel's name as shown: "#design", "Mika".
  where: string
  api: { httpBase: string; orgId: string; sessionToken: string }
  /// The photo of someone in the call, by their member ref.
  faceOf: (ref: string | null) => string | null | undefined
  me: { name: string; avatarUrl: string | null }
  onLeave: () => void
  /// Tuck the panel away; the call goes on in the bar.
  onHide: () => void
}

/// A picture from a stream, playing.
const Video: React.FC<{ stream: MediaStream; mirror?: boolean; contain?: boolean }> = ({ stream, mirror, contain }) => {
  const ref = useRef<HTMLVideoElement>(null)
  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (el.srcObject !== stream) el.srcObject = stream
    void el.play().catch(() => { /* muted autoplay is allowed; this is muted */ })
  }, [stream])
  return <video ref={ref} className={`jam-video${mirror ? ' mirror' : ''}${contain ? ' contain' : ''}`} autoPlay playsInline muted />
}

function clock(from: string | null, now: number): string {
  if (!from) return '0:00'
  const s = Math.max(0, Math.floor((now - Date.parse(from)) / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}

/// The Jam you are in, beside the conversation: who is in it and who is
/// talking, their cameras and whatever is being shown, the controls, and
/// underneath the Jam's own thread and a live transcript of what is said.
export const JamPanel: React.FC<Props> = ({ call, where, api, faceOf, me, onLeave, onHide }) => {
  const t = useT()
  const [now, setNow] = useState(Date.now())
  useEffect(() => { const id = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(id) }, [])
  const [expanded, setExpanded] = useState(false)
  const [tab, setTab] = useState<'thread' | 'transcript'>('thread')
  const [menu, setMenu] = useState<null | 'mic' | 'camera' | 'react'>(null)
  const [devices, setDevices] = useState<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] }>({ inputs: [], outputs: [], cameras: [] })
  const [problem, setProblem] = useState<string | null>(null)
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!menu) return
    void audioDevices().then(setDevices)
    const away = (e: MouseEvent) => { if (!(e.target as HTMLElement)?.closest?.('.jam-menu-wrap')) setMenu(null) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setMenu(null) }
    document.addEventListener('mousedown', away)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', away); document.removeEventListener('keydown', esc) }
  }, [menu])

  const others = call.participants.filter((p) => p.peerId !== call.peerId)
  const mine = call.participants.find((p) => p.peerId === call.peerId)
  // What is shared takes the stage: someone else's screen, or your own.
  const shared = useMemo(() => {
    for (const p of others) { const s = call.media(p.peerId).screen; if (s) return { stream: s, name: p.name, mine: false } }
    return call.screen ? { stream: call.screen, name: me.name, mine: true } : null
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [call.participants, call.screen, now])

  const tile = (p: JamParticipant | null, self: boolean) => {
    const id = self ? 'me' : p!.peerId
    const name = self ? me.name : p!.name
    const camera = self ? call.camera : call.media(p!.peerId).camera
    const muted = self ? call.muted : p!.muted
    const url = self ? me.avatarUrl : (p!.avatarUrl || faceOf(p!.ref))
    return (
      <div key={id} className={`jam-tile${call.speaking.has(id) ? ' speaking' : ''}${camera ? ' has-video' : ''}${muted ? ' muted' : ''}`} data-peer={id}>
        {camera ? <Video stream={camera} mirror={self} /> : <Avatar name={name} url={url} size={shared ? 36 : 56} round />}
        <span className="jam-tile-name">
          {muted && <Icon name="mic-off" size={11} />}
          {name}{self ? ` (${t('you')})` : ''}
        </span>
      </div>
    )
  }

  const act = async (fn: () => Promise<void>, fail: string) => {
    setProblem(null)
    try { await fn() } catch { setProblem(t(fail)) }
  }

  const transcriptEnd = useRef<HTMLDivElement>(null)
  useEffect(() => { transcriptEnd.current?.scrollIntoView({ block: 'end' }) }, [call.transcript.length, tab])

  return (
    <aside ref={box} className={`jam-panel${expanded ? ' expanded' : ''}`} aria-label={t('Jam in {where}', { where })} data-jam-panel="1">
      <header className="jam-head">
        <span className="jam-live" aria-label={t('Live')}><i aria-hidden="true" /> {clock(call.startedAt, now)}</span>
        <span className="jam-where">{where}</span>
        {call.recording && <span className="jam-rec">● {t('Recording')}</span>}
        <span className="jam-head-actions">
          <button type="button" className="jam-icon" onClick={() => setExpanded((x) => !x)} aria-label={expanded ? t('Shrink') : t('Expand')} title={expanded ? t('Shrink') : t('Expand')}>
            <Icon name={expanded ? 'minimize' : 'maximize'} size={15} />
          </button>
          <button type="button" className="jam-icon" onClick={onHide} aria-label={t('Hide')} title={t('Hide')}><Icon name="x" size={15} /></button>
        </span>
      </header>

      <div className={`jam-stage${shared ? ' sharing' : ''}`}>
        {shared && (
          <div className="jam-shared">
            <Video stream={shared.stream} contain />
            <span className="jam-tile-name"><Icon name="monitor" size={11} /> {shared.mine ? t('You are sharing your screen') : t('{name} is sharing', { name: shared.name })}</span>
          </div>
        )}
        <div className={`jam-tiles n${Math.min(4, others.length + 1)}`}>
          {tile(mine || null, true)}
          {others.map((p) => tile(p, false))}
        </div>
        {!call.inCall && <p className="jam-connecting" role="status">{t('Connecting…')}</p>}
        {call.inCall && others.length === 0 && <p className="jam-connecting" role="status">{t('Waiting for others…')}</p>}
        <div className="jam-floats" aria-hidden="true">
          {call.reactions.map((r, i) => <span key={r.id} className="jam-float" style={{ left: `${12 + ((i * 37) % 70)}%` }}>{r.emoji}<b>{r.name}</b></span>)}
        </div>
      </div>

      <div className="jam-controls" role="toolbar" aria-label={t('Jam controls')}>
        <span className="jam-menu-wrap jam-split">
          <button type="button" className={`jam-ctl${call.muted ? ' off' : ''}`} onClick={() => call.setMuted(!call.muted)} aria-pressed={!call.muted} aria-label={call.muted ? t('Unmute') : t('Mute')} title={call.muted ? t('Unmute') : t('Mute')} data-jam-mic="1">
            <Icon name={call.muted ? 'mic-off' : 'mic'} size={17} />
          </button>
          <button type="button" className="jam-ctl more" onClick={() => setMenu((m) => (m === 'mic' ? null : 'mic'))} aria-label={t('Microphone and speaker')} aria-expanded={menu === 'mic'}><Icon name="chevron-down" size={13} /></button>
          {menu === 'mic' && (
            <div className="jam-menu" role="menu">
              <div className="jam-menu-label">{t('Microphone')}</div>
              {devices.inputs.map((d, i) => (
                <button key={d.deviceId || i} type="button" role="menuitem" onClick={() => { setMenu(null); void act(() => call.setMic(d.deviceId), 'That microphone could not be opened.') }}>{d.label || `${t('Microphone')} ${i + 1}`}</button>
              ))}
              {devices.outputs.length > 0 && <div className="jam-menu-label">{t('Speaker')}</div>}
              {devices.outputs.map((d, i) => (
                <button key={d.deviceId || i} type="button" role="menuitem" onClick={() => { setMenu(null); void call.setSpeaker(d.deviceId) }}>{d.label || `${t('Speaker')} ${i + 1}`}</button>
              ))}
            </div>
          )}
        </span>
        <span className="jam-menu-wrap jam-split">
          <button type="button" className={`jam-ctl${call.camera ? '' : ' off'}`} onClick={() => void act(() => call.setCamera(!call.camera), 'Your camera could not be opened. Allow it for this site and try again.')} aria-pressed={Boolean(call.camera)} aria-label={call.camera ? t('Turn camera off') : t('Turn camera on')} title={call.camera ? t('Turn camera off') : t('Turn camera on')} data-jam-camera="1">
            <Icon name={call.camera ? 'video' : 'video-off'} size={17} />
          </button>
          <button type="button" className="jam-ctl more" onClick={() => setMenu((m) => (m === 'camera' ? null : 'camera'))} aria-label={t('Camera')} aria-expanded={menu === 'camera'}><Icon name="chevron-down" size={13} /></button>
          {menu === 'camera' && (
            <div className="jam-menu" role="menu">
              <div className="jam-menu-label">{t('Camera')}</div>
              {devices.cameras.length === 0 && <div className="jam-menu-empty">{t('No camera found.')}</div>}
              {devices.cameras.map((d, i) => (
                <button key={d.deviceId || i} type="button" role="menuitem" onClick={() => { setMenu(null); void act(() => call.setCamera(true, d.deviceId), 'Your camera could not be opened. Allow it for this site and try again.') }}>{d.label || `${t('Camera')} ${i + 1}`}</button>
              ))}
            </div>
          )}
        </span>
        {canShareScreen() && (
          <button type="button" className={`jam-ctl${call.screen ? ' on' : ''}`} onClick={() => void act(() => call.setScreen(!call.screen), 'The screen could not be shared.')} aria-pressed={Boolean(call.screen)} aria-label={call.screen ? t('Stop sharing') : t('Share your screen')} title={call.screen ? t('Stop sharing') : t('Share your screen')} data-jam-screen="1">
            <Icon name="monitor" size={17} />
          </button>
        )}
        <span className="jam-menu-wrap">
          <button type="button" className="jam-ctl" onClick={() => setMenu((m) => (m === 'react' ? null : 'react'))} aria-label={t('React')} aria-expanded={menu === 'react'} title={t('React')}><Icon name="smile" size={17} /></button>
          {menu === 'react' && (
            <div className="jam-menu jam-reactions" role="menu">
              {JAM_REACTIONS.map((e) => <button key={e} type="button" role="menuitem" onClick={() => { setMenu(null); call.react(e) }} aria-label={e}>{e}</button>)}
            </div>
          )}
        </span>
        <button type="button" className="jam-ctl leave" onClick={onLeave} aria-label={t('Leave Jam')} title={t('Leave Jam')} data-jam-leave="1"><Icon name="phone-off" size={17} /></button>
      </div>
      {problem && <p className="jam-problem" role="alert">{problem}</p>}

      <nav className="jam-tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'thread'} onClick={() => setTab('thread')}><Icon name="message" size={13} /> {t('Thread')}</button>
        <button type="button" role="tab" aria-selected={tab === 'transcript'} onClick={() => setTab('transcript')} data-jam-transcript-tab="1">
          <span className={`jam-rec-dot${call.mode !== 'off' ? ' on' : ''}`} aria-hidden="true" /> {t('Live transcript')}
        </button>
      </nav>
      <div className="jam-tab-body">
        {tab === 'thread' ? (
          <JamThread api={api} channel={call.channel} messageId={call.messageId} />
        ) : (
          <div className="jam-transcript" aria-live="polite">
            {call.mode === 'off' && <p className="jam-empty">{t('This Jam is not recorded, so nothing is written down.')}</p>}
            {call.mode !== 'off' && !canTranscribe() && <p className="jam-empty">{t('This browser cannot write down what you say; others’ words still appear here.')}</p>}
            {call.mode !== 'off' && call.transcript.length === 0 && Object.keys(call.interim).length === 0 && <p className="jam-empty">{t('What is said appears here as it is said.')}</p>}
            {call.transcript.map((l, i) => (
              <p key={`${l.at}-${i}`} className="jam-line"><b>{l.name}</b> <span>{l.text}</span></p>
            ))}
            {Object.values(call.interim).map((l) => (
              <p key={`interim-${l.peerId}`} className="jam-line interim"><b>{l.name}</b> <span>{l.text}</span></p>
            ))}
            <div ref={transcriptEnd} />
          </div>
        )}
      </div>
    </aside>
  )
}

/// The Jam's own thread: replies under the message it started with.
const JamThread: React.FC<{ api: Props['api']; channel: string; messageId: string | null }> = ({ api, channel, messageId }) => {
  const t = useT()
  const [replies, setReplies] = useState<ChannelMessage[] | null>(null)
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const headers = useMemo(() => ({ 'x-session-token': api.sessionToken }), [api.sessionToken])
  useEffect(() => {
    if (!messageId) { setReplies([]); return }
    let ignore = false
    fetch(`${api.httpBase}/channels/thread?orgId=${encodeURIComponent(api.orgId)}&channel=${encodeURIComponent(channel)}&messageId=${encodeURIComponent(messageId)}`, { headers })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => { if (!ignore) setReplies(d?.replies || []) })
      .catch(() => { if (!ignore) setReplies([]) })
    const on = (e: Event) => {
      const m = (e as CustomEvent<ChannelMessage>).detail
      if (m?.parentId === messageId) setReplies((prev) => (prev ? (prev.some((x) => x.id === m.id) ? prev.map((x) => (x.id === m.id ? m : x)) : [...prev, m]) : [m]))
    }
    window.addEventListener('honmaru:channel-message', on)
    return () => { ignore = true; window.removeEventListener('honmaru:channel-message', on) }
  }, [api.httpBase, api.orgId, channel, messageId, headers])
  const send = async () => {
    const body = draft.trim()
    if (!body || !messageId || sending) return
    setSending(true)
    try {
      const res = await fetch(`${api.httpBase}/channels/messages`, {
        method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
        body: JSON.stringify({ orgId: api.orgId, channel, body, parentId: messageId }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok && data.message) { setDraft(''); setReplies((prev) => (prev && !prev.some((x) => x.id === data.message.id) ? [...prev, data.message] : prev)) }
    } finally { setSending(false) }
  }
  return (
    <div className="jam-thread">
      <div className="jam-thread-log">
        {replies === null && <p className="jam-empty">{t('Loading…')}</p>}
        {replies && replies.length === 0 && <p className="jam-empty">{t('Links, notes, anything for the people in this Jam. It stays in the channel under the Jam.')}</p>}
        {(replies || []).filter((m) => !m.deleted).map((m) => (
          <p key={m.id} className="jam-line"><b>{m.kind === 'ai' ? t('Your AI') : m.mine ? t('You') : (m.authorName || t('a teammate'))}</b> <span>{m.body}</span></p>
        ))}
      </div>
      <form className="jam-compose" onSubmit={(e) => { e.preventDefault(); void send() }}>
        <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder={t('Message the Jam…')} aria-label={t('Message the Jam')} disabled={!messageId} />
        <button type="submit" className="jam-send" disabled={!draft.trim() || sending || !messageId} aria-label={t('Send')}><Icon name="send" size={14} /></button>
      </form>
    </div>
  )
}
