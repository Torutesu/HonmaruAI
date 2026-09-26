// A Jam, from this browser: the microphone — and a camera, a shared screen
// when they are switched on — sent to everyone else in it over WebRTC (a
// mesh; the relay only introduces us and carries offers, answers and
// candidates), their voices out of the chosen speaker and their pictures on
// the stage, a live transcript of what everyone says, reactions, and — when
// the Jam is recorded and this browser is the recorder — everyone's voices
// mixed into one track, uploaded when this browser leaves.
//
// Each pair of browsers negotiates the "perfect negotiation" way: either side
// may offer whenever what it sends changes (a camera on, a screen shared),
// and when both offer at once the polite one — decided by comparing the two
// peer ids — gives way. That is what lets a camera or a screen come and go in
// a call already running, which the first version (audio only, the newcomer
// always offering) could not do.
//
// Which incoming picture is a camera and which is a screen travels with the
// negotiation as the ids of the streams they arrive in.

export type JamMode = 'full' | 'notes' | 'off'

export interface JamParticipant {
  peerId: string
  ref: string | null
  name: string
  muted: boolean
  since: string
  video?: boolean
  screen?: boolean
  avatarUrl?: string | null
}

export interface JamState {
  channel: string
  active: boolean
  participants: JamParticipant[]
  startedAt: string | null
  mode: JamMode
  recorderPeerId: string | null
  /// The message the Jam started with; its thread is the Jam's own.
  messageId?: string | null
}

export interface TranscriptLine {
  peerId?: string
  ref?: string | null
  name: string
  text: string
  at: string
}

export interface JamReaction { id: string; peerId: string; name: string; emoji: string }

export const JAM_MODES: JamMode[] = ['full', 'notes', 'off']
export const JAM_REACTIONS = ['👍', '👏', '😂', '🎉', '❤️', '🙏', '👀', '🔥']

/// Hand a message to the relay, through whoever holds the socket.
export function sendJam(type: string, payload: unknown): void {
  window.dispatchEvent(new CustomEvent('honmaru:jam-send', { detail: { type, payload } }))
}

/// The container a recording is made in, where the browser can.
export function recordingMime(): string | null {
  if (typeof MediaRecorder === 'undefined') return null
  for (const type of ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4']) {
    try { if (MediaRecorder.isTypeSupported(type)) return type } catch { /* not this one */ }
  }
  return null
}

/// The devices a Jam can use, by label when the browser will say.
export async function audioDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[]; cameras: MediaDeviceInfo[] }> {
  if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [], cameras: [] }
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
  return {
    inputs: all.filter((d) => d.kind === 'audioinput'),
    outputs: all.filter((d) => d.kind === 'audiooutput'),
    cameras: all.filter((d) => d.kind === 'videoinput'),
  }
}

/// Can this browser choose where sound comes out?
export function canPickSpeaker(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
}

/// Can this browser share a screen? (Phones mostly cannot.)
export function canShareScreen(): boolean {
  return typeof navigator !== 'undefined' && Boolean(navigator.mediaDevices && 'getDisplayMedia' in navigator.mediaDevices)
}

type Recognition = {
  lang: string; continuous: boolean; interimResults: boolean
  onresult: ((e: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null
  onend: (() => void) | null
  onerror: ((e: { error?: string }) => void) | null
  start: () => void; stop: () => void; abort: () => void
}
function speechRecognition(): (new () => Recognition) | null {
  if (typeof window === 'undefined') return null
  const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition }
  return w.SpeechRecognition || w.webkitSpeechRecognition || null
}
/// Can this browser write down what is said, live?
export function canTranscribe(): boolean { return Boolean(speechRecognition()) }

interface Peer {
  pc: RTCPeerConnection
  polite: boolean
  makingOffer: boolean
  ignoreOffer: boolean
  audio: HTMLAudioElement
  voice: MediaStream | null
  camera: MediaStream | null
  screen: MediaStream | null
  /// Stream id → what it is, as the other side told us.
  kinds: { camera: string | null; screen: string | null }
  /// Streams that arrived before we knew what they were.
  unplaced: Map<string, MediaStream>
  source?: MediaStreamAudioSourceNode
  senders: { camera: RTCRtpSender[]; screen: RTCRtpSender[] }
}

export interface JamCallOptions {
  /// The channel as this browser names it (`b:slug`, `dm:ref`).
  channel: string
  mode: JamMode
  micId?: string
  speakerId?: string
  cameraId?: string
  muted?: boolean
  /// Language for the live transcript (a BCP 47 tag).
  lang?: string
  /// Something changed that the screen shows.
  onChange: () => void
  /// Said when the call cannot go on, in words for a person.
  onProblem: (message: string) => void
  /// Someone came in or went out (not this browser): for the sound.
  onPeople?: (change: 'joined' | 'left') => void
  /// The recording, when this browser made one, as it leaves.
  upload: (blob: Blob, meta: { mode: JamMode; startedAt: string; endedAt: string; people: string[] }) => Promise<void>
}

export class JamCall {
  readonly channel: string
  mode: JamMode
  peerId: string | null = null
  participants: JamParticipant[] = []
  muted: boolean
  startedAt: string | null = null
  messageId: string | null = null
  recording = false
  /// Final lines, oldest first; and what each person is saying right now.
  transcript: TranscriptLine[] = []
  interim: Record<string, TranscriptLine> = {}
  reactions: JamReaction[] = []
  /// Who is making a sound right now: peer ids, and 'me'.
  speaking = new Set<string>()
  camera: MediaStream | null = null
  screen: MediaStream | null = null
  private opts: JamCallOptions
  private speakerId: string | undefined
  private local: MediaStream | null = null
  private iceServers: RTCIceServer[] = []
  private peers = new Map<string, Peer>()
  private ctx: AudioContext | null = null
  private mix: MediaStreamAudioDestinationNode | null = null
  private recorder: MediaRecorder | null = null
  private chunks: Blob[] = []
  private recordFrom: string | null = null
  private heard = new Set<string>()
  private left = false
  private meters = new Map<string, { analyser: AnalyserNode; source: MediaStreamAudioSourceNode; data: Uint8Array<ArrayBuffer> }>()
  private meterTimer: ReturnType<typeof setInterval> | null = null
  private recognition: Recognition | null = null
  private lastInterimAt = 0
  private listener = (e: Event) => {
    const { name, value } = (e as CustomEvent<{ name: string; value: any }>).detail || {}
    if (name) void this.onEvent(name, value)
  }

  constructor(opts: JamCallOptions) {
    this.opts = opts
    this.channel = opts.channel
    this.mode = opts.mode
    this.muted = Boolean(opts.muted)
    this.speakerId = opts.speakerId
  }

  /// Open the microphone and ask to join. Throws the browser's refusal.
  async start(): Promise<void> {
    this.local = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(this.opts.micId ? { deviceId: { exact: this.opts.micId } } : {}),
        echoCancellation: true, noiseSuppression: true, autoGainControl: true,
      },
    })
    for (const track of this.local.getAudioTracks()) track.enabled = !this.muted
    window.addEventListener('honmaru:jam', this.listener)
    sendJam('jam_join', { channel: this.channel, mode: this.mode, muted: this.muted })
    this.meter('me', this.local)
  }

  /// Left, by choice or because the call could not go on.
  get ended(): boolean { return this.left }
  get inCall(): boolean { return Boolean(this.peerId) && !this.left }

  /// What each other person sends, for the stage.
  media(peerId: string): { camera: MediaStream | null; screen: MediaStream | null } {
    const p = this.peers.get(peerId)
    return { camera: p?.camera || null, screen: p?.screen || null }
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    for (const track of this.local?.getAudioTracks() || []) track.enabled = !muted
    sendJam('jam_mute', { muted })
    if (muted) this.stopTranscript(); else this.startTranscript()
    this.opts.onChange()
  }

  async setSpeaker(id: string): Promise<void> {
    this.speakerId = id
    for (const peer of this.peers.values()) await this.route(peer.audio)
  }

  /// Another microphone, without leaving: the new track replaces the old in
  /// every call.
  async setMic(id: string): Promise<void> {
    const next = await navigator.mediaDevices.getUserMedia({ audio: { deviceId: { exact: id }, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
    const track = next.getAudioTracks()[0]
    if (!track) return
    track.enabled = !this.muted
    for (const peer of this.peers.values()) {
      for (const sender of peer.pc.getSenders()) if (sender.track?.kind === 'audio') await sender.replaceTrack(track).catch(() => {})
    }
    for (const old of this.local?.getAudioTracks() || []) { this.local?.removeTrack(old); old.stop() }
    this.local?.addTrack(track)
    if (this.local) this.meter('me', this.local)
  }

  /// The camera on or off. On, it goes to everyone in the call.
  async setCamera(on: boolean, deviceId?: string): Promise<void> {
    if (!on) {
      for (const t of this.camera?.getTracks() || []) t.stop()
      this.camera = null
      for (const peer of this.peers.values()) this.unsend(peer, 'camera')
    } else {
      const stream = await navigator.mediaDevices.getUserMedia({ video: { ...(deviceId ? { deviceId: { exact: deviceId } } : {}), width: { ideal: 1280 }, height: { ideal: 720 } } })
      for (const t of this.camera?.getTracks() || []) t.stop()
      if (this.camera) for (const peer of this.peers.values()) this.unsend(peer, 'camera')
      this.camera = stream
      for (const peer of this.peers.values()) this.send(peer, 'camera', stream)
    }
    this.announceMedia()
  }

  /// Share a screen, or stop. The browser asks which; stopping from the
  /// browser's own bar stops it here too.
  async setScreen(on: boolean): Promise<void> {
    if (!on) {
      for (const t of this.screen?.getTracks() || []) t.stop()
      this.screen = null
      for (const peer of this.peers.values()) this.unsend(peer, 'screen')
    } else {
      const stream = await (navigator.mediaDevices as MediaDevices & { getDisplayMedia: (c?: MediaStreamConstraints) => Promise<MediaStream> })
        .getDisplayMedia({ video: { frameRate: { ideal: 15, max: 30 } }, audio: false })
      this.screen = stream
      const [track] = stream.getVideoTracks()
      if (track) track.onended = () => { if (this.screen === stream) void this.setScreen(false) }
      for (const peer of this.peers.values()) this.send(peer, 'screen', stream)
    }
    this.announceMedia()
  }

  react(emoji: string): void { sendJam('jam_react', { emoji }) }

  /// Out of the Jam: the recording goes up, the calls and the devices close.
  async leave(): Promise<void> {
    if (this.left) return
    this.left = true
    window.removeEventListener('honmaru:jam', this.listener)
    sendJam('jam_leave', {})
    this.stopTranscript()
    const recorded = await this.stopRecording()
    for (const id of [...this.peers.keys()]) this.hangUp(id)
    for (const s of [this.local, this.camera, this.screen]) for (const track of s?.getTracks() || []) track.stop()
    this.local = null; this.camera = null; this.screen = null
    if (this.meterTimer) clearInterval(this.meterTimer)
    this.meterTimer = null
    this.meters.clear()
    void this.ctx?.close().catch(() => {})
    this.ctx = null
    this.opts.onChange()
    if (recorded) await this.opts.upload(recorded.blob, recorded.meta).catch(() => this.opts.onProblem('The recording did not upload.'))
  }

  private announceMedia(): void {
    sendJam('jam_media', { video: Boolean(this.camera), screen: Boolean(this.screen) })
    for (const [remote] of this.peers) this.tellKinds(remote)
    this.opts.onChange()
  }

  private tellKinds(remote: string): void {
    sendJam('jam_signal', { to: remote, data: { kinds: { camera: this.camera?.id || null, screen: this.screen?.id || null } } })
  }

  private async onEvent(name: string, value: any): Promise<void> {
    if (this.left) return
    if (name === 'jam_joined' && value?.channel === this.channel) {
      this.peerId = value.peerId
      this.iceServers = Array.isArray(value.iceServers) ? value.iceServers : []
      this.mode = value.mode || this.mode
      this.startedAt = value.startedAt || new Date().toISOString()
      this.messageId = value.messageId || null
      this.transcript = Array.isArray(value.transcript) ? value.transcript.map((l: TranscriptLine) => ({ ...l })) : []
      // The newcomer reaches out; perfect negotiation settles who offers.
      for (const remote of value.peers || []) this.peer(remote)
      this.startTranscript()
      this.opts.onChange()
      return
    }
    if (name === 'jam_error' && (!value?.channel || value.channel === this.channel)) {
      this.opts.onProblem(value?.message || 'The Jam could not start.')
      void this.leave()
      return
    }
    if (name === 'jam_signal' && this.peerId && value?.from) {
      await this.signal(value.from, value.data || {})
      return
    }
    if (name === 'jam_state' && value?.channel === this.channel) {
      const state = value as JamState
      const before = new Set(this.participants.map((p) => p.peerId))
      this.participants = state.participants || []
      this.mode = state.mode || this.mode
      if (state.messageId) this.messageId = state.messageId
      for (const p of this.participants) if (p.ref) this.heard.add(p.ref)
      const here = new Set(this.participants.map((p) => p.peerId))
      // Someone gone: their call goes too.
      for (const id of [...this.peers.keys()]) if (!here.has(id)) this.hangUp(id)
      if (this.peerId && before.size) {
        const came = [...here].some((id) => id !== this.peerId && !before.has(id))
        const went = [...before].some((id) => id !== this.peerId && !here.has(id))
        if (came) this.opts.onPeople?.('joined')
        else if (went) this.opts.onPeople?.('left')
      }
      if (this.peerId && state.recorderPeerId === this.peerId && this.mode !== 'off' && !this.recorder) this.startRecording()
      this.opts.onChange()
      return
    }
    if (name === 'jam_transcript' && value?.channel === this.channel) {
      const line: TranscriptLine = { peerId: value.peerId, ref: value.ref, name: value.name, text: value.text, at: value.at }
      if (value.final) {
        this.transcript = [...this.transcript, line].slice(-500)
        delete this.interim[value.peerId]
      } else {
        this.interim = { ...this.interim, [value.peerId]: line }
      }
      this.opts.onChange()
      return
    }
    if (name === 'jam_reaction' && value?.channel === this.channel) {
      const r: JamReaction = { id: `${value.peerId}-${value.at}-${Math.random()}`, peerId: value.peerId, name: value.name, emoji: value.emoji }
      this.reactions = [...this.reactions, r].slice(-12)
      this.opts.onChange()
      setTimeout(() => { this.reactions = this.reactions.filter((x) => x.id !== r.id); this.opts.onChange() }, 3200)
      return
    }
    // A new socket: the relay has forgotten this browser was here.
    if (name === 'reset' && this.peerId) {
      for (const id of [...this.peers.keys()]) this.hangUp(id)
      this.peerId = null
      sendJam('jam_join', { channel: this.channel, mode: this.mode, muted: this.muted })
    }
  }

  private peer(remote: string): Peer {
    const existing = this.peers.get(remote)
    if (existing) return existing
    const pc = new RTCPeerConnection({ iceServers: this.iceServers })
    const audio = new Audio()
    audio.autoplay = true
    const peer: Peer = {
      pc, polite: String(this.peerId || '') > remote, makingOffer: false, ignoreOffer: false,
      audio, voice: null, camera: null, screen: null, kinds: { camera: null, screen: null }, unplaced: new Map(),
      senders: { camera: [], screen: [] },
    }
    this.peers.set(remote, peer)
    pc.onnegotiationneeded = async () => {
      try {
        peer.makingOffer = true
        await pc.setLocalDescription()
        sendJam('jam_signal', { to: remote, data: { sdp: pc.localDescription?.toJSON?.() ?? pc.localDescription } })
        this.tellKinds(remote)
      } catch (err) {
        console.warn('jam offer failed', err)
      } finally { peer.makingOffer = false }
    }
    pc.onicecandidate = (e) => {
      if (e.candidate) sendJam('jam_signal', { to: remote, data: { candidate: e.candidate.toJSON() } })
    }
    pc.ontrack = (e) => {
      const stream = e.streams[0] || new MediaStream([e.track])
      if (e.track.kind === 'audio') {
        peer.voice = stream
        audio.srcObject = stream
        void this.route(audio)
        void audio.play().catch(() => { /* played on the next gesture */ })
        this.mixIn(peer, stream)
        this.meter(remote, stream)
      } else {
        this.place(peer, stream)
      }
      e.track.onunmute = () => this.opts.onChange()
      this.opts.onChange()
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        try { pc.restartIce() } catch { /* older browser */ }
      }
      this.opts.onChange()
    }
    for (const track of this.local?.getAudioTracks() || []) pc.addTrack(track, this.local!)
    if (this.camera) this.send(peer, 'camera', this.camera)
    if (this.screen) this.send(peer, 'screen', this.screen)
    return peer
  }

  private send(peer: Peer, kind: 'camera' | 'screen', stream: MediaStream): void {
    for (const track of stream.getVideoTracks()) {
      try { peer.senders[kind].push(peer.pc.addTrack(track, stream)) } catch { /* closed */ }
    }
  }

  private unsend(peer: Peer, kind: 'camera' | 'screen'): void {
    for (const sender of peer.senders[kind]) { try { peer.pc.removeTrack(sender) } catch { /* closed */ } }
    peer.senders[kind] = []
  }

  /// Put an incoming picture where it belongs, once we know which it is.
  private place(peer: Peer, stream: MediaStream): void {
    if (peer.kinds.screen && stream.id === peer.kinds.screen) peer.screen = stream
    else if (peer.kinds.camera && stream.id === peer.kinds.camera) peer.camera = stream
    else peer.unplaced.set(stream.id, stream)
  }

  private async signal(from: string, data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; kinds?: { camera: string | null; screen: string | null } }): Promise<void> {
    const peer = this.peer(from)
    const { pc } = peer
    try {
      if (data.kinds) {
        peer.kinds = { camera: data.kinds.camera || null, screen: data.kinds.screen || null }
        if (!peer.kinds.camera) peer.camera = null
        if (!peer.kinds.screen) peer.screen = null
        for (const [id, stream] of [...peer.unplaced]) {
          if (id === peer.kinds.camera || id === peer.kinds.screen) { peer.unplaced.delete(id); this.place(peer, stream) }
        }
        this.opts.onChange()
        return
      }
      if (data.sdp) {
        const collision = data.sdp.type === 'offer' && (peer.makingOffer || pc.signalingState !== 'stable')
        peer.ignoreOffer = !peer.polite && collision
        if (peer.ignoreOffer) return
        await pc.setRemoteDescription(data.sdp)
        if (data.sdp.type === 'offer') {
          await pc.setLocalDescription()
          sendJam('jam_signal', { to: from, data: { sdp: pc.localDescription?.toJSON?.() ?? pc.localDescription } })
          this.tellKinds(from)
        }
      } else if (data.candidate) {
        try { await pc.addIceCandidate(data.candidate) } catch (err) { if (!peer.ignoreOffer) console.warn('jam candidate failed', err) }
      }
    } catch (err) {
      console.warn('jam signal failed', err)
    }
  }

  private hangUp(remote: string): void {
    const peer = this.peers.get(remote)
    if (!peer) return
    this.peers.delete(remote)
    try { peer.source?.disconnect() } catch { /* already */ }
    try { peer.pc.close() } catch { /* already */ }
    peer.audio.srcObject = null
    const m = this.meters.get(remote)
    if (m) { try { m.source.disconnect() } catch { /* already */ } this.meters.delete(remote) }
    this.speaking.delete(remote)
  }

  private async route(audio: HTMLAudioElement): Promise<void> {
    const sink = (audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId
    if (this.speakerId && sink) await sink.call(audio, this.speakerId).catch(() => {})
  }

  // ---- Who is speaking ----

  private audio(): AudioContext | null {
    if (this.ctx) return this.ctx
    try { this.ctx = new AudioContext() } catch { return null }
    return this.ctx
  }

  private meter(id: string, stream: MediaStream): void {
    const ctx = this.audio()
    if (!ctx || !stream.getAudioTracks().length) return
    const old = this.meters.get(id)
    if (old) { try { old.source.disconnect() } catch { /* already */ } }
    try {
      const source = ctx.createMediaStreamSource(stream)
      const analyser = ctx.createAnalyser()
      analyser.fftSize = 512
      source.connect(analyser)
      this.meters.set(id, { analyser, source, data: new Uint8Array(new ArrayBuffer(analyser.fftSize)) })
    } catch { return }
    if (!this.meterTimer) {
      this.meterTimer = setInterval(() => {
        let changed = false
        for (const [who, m] of this.meters) {
          m.analyser.getByteTimeDomainData(m.data)
          let sum = 0
          for (const v of m.data) { const x = (v - 128) / 128; sum += x * x }
          const loud = Math.sqrt(sum / m.data.length) > 0.035 && !(who === 'me' && this.muted)
          if (loud !== this.speaking.has(who)) { changed = true; if (loud) this.speaking.add(who); else this.speaking.delete(who) }
        }
        if (changed) this.opts.onChange()
      }, 180)
    }
  }

  // ---- The live transcript ----
  //
  // Each browser writes down its own person, in their language, with the
  // browser's own speech recognition — nothing leaves for a third party that
  // was not already going to — and sends each line to the others. Not when
  // the Jam is not to be recorded, and not while muted.

  private startTranscript(): void {
    if (this.recognition || this.left || this.muted || this.mode === 'off' || !this.peerId) return
    const Rec = speechRecognition()
    if (!Rec) return
    try {
      const rec = new Rec()
      rec.lang = this.opts.lang || (typeof navigator !== 'undefined' ? navigator.language : 'en-US')
      rec.continuous = true
      rec.interimResults = true
      rec.onresult = (e) => {
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const result = e.results[i]
          const text = String(result[0]?.transcript || '').trim()
          if (!text) continue
          if (result.isFinal) sendJam('jam_transcript', { text, final: true })
          else if (Date.now() - this.lastInterimAt > 700) { this.lastInterimAt = Date.now(); sendJam('jam_transcript', { text, final: false }) }
        }
      }
      // Recognition stops by itself after a silence; while still in the
      // call, it starts again.
      rec.onend = () => {
        if (this.recognition !== rec) return
        this.recognition = null
        if (!this.left && !this.muted) setTimeout(() => this.startTranscript(), 400)
      }
      rec.onerror = (e) => { if (e?.error === 'not-allowed' || e?.error === 'service-not-allowed') this.recognition = null }
      this.recognition = rec
      rec.start()
    } catch { this.recognition = null }
  }

  private stopTranscript(): void {
    const rec = this.recognition
    this.recognition = null
    try { rec?.abort() } catch { /* already */ }
  }

  // ---- The recording ----

  private startRecording(): void {
    const mime = recordingMime()
    if (!mime || !this.local) return
    try {
      const ctx = this.audio()
      if (!ctx) return
      this.mix = ctx.createMediaStreamDestination()
      ctx.createMediaStreamSource(this.local).connect(this.mix)
      for (const peer of this.peers.values()) if (peer.voice) this.mixIn(peer, peer.voice)
      this.recorder = new MediaRecorder(this.mix.stream, { mimeType: mime, audioBitsPerSecond: 24000 })
      this.chunks = []
      this.recorder.ondataavailable = (e) => { if (e.data.size) this.chunks.push(e.data) }
      this.recorder.start(10_000)
      this.recordFrom = new Date().toISOString()
      this.recording = true
    } catch (err) {
      console.warn('jam recording failed', err)
      this.recorder = null
      this.recording = false
    }
  }

  private mixIn(peer: Peer, stream: MediaStream): void {
    if (!this.ctx || !this.mix || peer.source) return
    try {
      peer.source = this.ctx.createMediaStreamSource(stream)
      peer.source.connect(this.mix)
    } catch { /* this voice is heard, not recorded */ }
  }

  private stopRecording(): Promise<{ blob: Blob; meta: { mode: JamMode; startedAt: string; endedAt: string; people: string[] } } | null> {
    const recorder = this.recorder
    if (!recorder || recorder.state === 'inactive') return Promise.resolve(null)
    this.recorder = null
    this.recording = false
    return new Promise((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(this.chunks, { type: (recorder.mimeType || 'audio/webm').split(';')[0] })
        this.chunks = []
        resolve(blob.size > 1024
          ? { blob, meta: { mode: this.mode, startedAt: this.recordFrom || this.startedAt || new Date().toISOString(), endedAt: new Date().toISOString(), people: [...this.heard] } }
          : null)
      }
      try { recorder.stop() } catch { resolve(null) }
    })
  }
}
