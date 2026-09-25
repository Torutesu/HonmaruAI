// A Jam, from this browser: the microphone, a call to everyone else in it
// (WebRTC, a mesh — the relay only introduces us and carries the offers,
// answers and candidates), their voices out of the chosen speaker, and — when
// the Jam is recorded and this browser is the one recording — everyone mixed
// into one track, uploaded when this browser leaves.
//
// The newcomer calls everyone already there and nobody calls the newcomer,
// so two browsers never offer to each other at once.

export type JamMode = 'full' | 'notes' | 'off'

export interface JamParticipant {
  peerId: string
  ref: string | null
  name: string
  muted: boolean
  since: string
}

export interface JamState {
  channel: string
  active: boolean
  participants: JamParticipant[]
  startedAt: string | null
  mode: JamMode
  recorderPeerId: string | null
}

export const JAM_MODES: JamMode[] = ['full', 'notes', 'off']

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
export async function audioDevices(): Promise<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }> {
  if (!navigator.mediaDevices?.enumerateDevices) return { inputs: [], outputs: [] }
  const all = await navigator.mediaDevices.enumerateDevices().catch(() => [] as MediaDeviceInfo[])
  return {
    inputs: all.filter((d) => d.kind === 'audioinput'),
    outputs: all.filter((d) => d.kind === 'audiooutput'),
  }
}

/// Can this browser choose where sound comes out?
export function canPickSpeaker(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype
}

interface Peer {
  pc: RTCPeerConnection
  audio: HTMLAudioElement
  pending: RTCIceCandidateInit[]
  source?: MediaStreamAudioSourceNode
}

export interface JamCallOptions {
  /// The channel as this browser names it (`b:slug`, `dm:ref`).
  channel: string
  mode: JamMode
  micId?: string
  speakerId?: string
  muted?: boolean
  /// Something changed that the screen shows.
  onChange: () => void
  /// Said when the call cannot go on, in words for a person.
  onProblem: (message: string) => void
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
  recording = false
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
  }

  /// Left, by choice or because the call could not go on.
  get ended(): boolean {
    return this.left
  }

  get inCall(): boolean {
    return Boolean(this.peerId) && !this.left
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    for (const track of this.local?.getAudioTracks() || []) track.enabled = !muted
    sendJam('jam_mute', { muted })
    this.opts.onChange()
  }

  async setSpeaker(id: string): Promise<void> {
    this.speakerId = id
    for (const peer of this.peers.values()) await this.route(peer.audio)
  }

  /// Out of the Jam: the recording goes up, the calls and the microphone
  /// close.
  async leave(): Promise<void> {
    if (this.left) return
    this.left = true
    window.removeEventListener('honmaru:jam', this.listener)
    sendJam('jam_leave', {})
    const recorded = await this.stopRecording()
    for (const id of [...this.peers.keys()]) this.hangUp(id)
    for (const track of this.local?.getTracks() || []) track.stop()
    this.local = null
    void this.ctx?.close().catch(() => {})
    this.ctx = null
    this.opts.onChange()
    if (recorded) await this.opts.upload(recorded.blob, recorded.meta).catch(() => this.opts.onProblem('The recording did not upload.'))
  }

  private async onEvent(name: string, value: any): Promise<void> {
    if (this.left) return
    if (name === 'jam_joined' && value?.channel === this.channel) {
      this.peerId = value.peerId
      this.iceServers = Array.isArray(value.iceServers) ? value.iceServers : []
      this.mode = value.mode || this.mode
      this.startedAt = value.startedAt || new Date().toISOString()
      for (const remote of value.peers || []) await this.call(remote)
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
      this.participants = state.participants || []
      this.mode = state.mode || this.mode
      for (const p of this.participants) if (p.ref) this.heard.add(p.ref)
      // Someone gone: their call goes too.
      const here = new Set(this.participants.map((p) => p.peerId))
      for (const id of [...this.peers.keys()]) if (!here.has(id)) this.hangUp(id)
      if (this.peerId && state.recorderPeerId === this.peerId && this.mode !== 'off' && !this.recorder) this.startRecording()
      this.opts.onChange()
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
    const peer: Peer = { pc, audio, pending: [] }
    this.peers.set(remote, peer)
    for (const track of this.local?.getAudioTracks() || []) pc.addTrack(track, this.local!)
    pc.onicecandidate = (e) => {
      if (e.candidate) sendJam('jam_signal', { to: remote, data: { candidate: e.candidate.toJSON() } })
    }
    pc.ontrack = (e) => {
      const [stream] = e.streams
      if (!stream) return
      audio.srcObject = stream
      void this.route(audio)
      void audio.play().catch(() => { /* played on the next gesture */ })
      this.mixIn(peer, stream)
    }
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed') {
        // Try once more from our side, with a fresh route.
        try { pc.restartIce() } catch { /* older browser */ }
      }
    }
    return peer
  }

  private async call(remote: string): Promise<void> {
    const { pc } = this.peer(remote)
    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    sendJam('jam_signal', { to: remote, data: { sdp: pc.localDescription?.toJSON?.() ?? offer } })
  }

  private async signal(from: string, data: { sdp?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit }): Promise<void> {
    const peer = this.peer(from)
    const { pc } = peer
    try {
      if (data.sdp) {
        await pc.setRemoteDescription(data.sdp)
        for (const c of peer.pending.splice(0)) await pc.addIceCandidate(c).catch(() => {})
        if (data.sdp.type === 'offer') {
          const answer = await pc.createAnswer()
          await pc.setLocalDescription(answer)
          sendJam('jam_signal', { to: from, data: { sdp: pc.localDescription?.toJSON?.() ?? answer } })
        }
      } else if (data.candidate) {
        if (pc.remoteDescription) await pc.addIceCandidate(data.candidate).catch(() => {})
        else peer.pending.push(data.candidate)
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
  }

  private async route(audio: HTMLAudioElement): Promise<void> {
    const sink = (audio as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }).setSinkId
    if (this.speakerId && sink) await sink.call(audio, this.speakerId).catch(() => {})
  }

  // ---- The recording ----

  private startRecording(): void {
    const mime = recordingMime()
    if (!mime || !this.local) return
    try {
      this.ctx = this.ctx || new AudioContext()
      this.mix = this.ctx.createMediaStreamDestination()
      this.ctx.createMediaStreamSource(this.local).connect(this.mix)
      for (const peer of this.peers.values()) {
        const stream = peer.audio.srcObject as MediaStream | null
        if (stream) this.mixIn(peer, stream)
      }
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
