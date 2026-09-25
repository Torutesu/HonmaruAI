import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { JamCall } from './jam'

// A Jam from this browser, with the browser's parts stood in for: what it
// sends the relay, whom it calls, and what it lets go of when it leaves.

type Sent = { type: string; payload: any }

class FakePC {
  static made: FakePC[] = []
  localDescription: any = null
  remoteDescription: any = null
  connectionState = 'new'
  signalingState = 'stable'
  closed = false
  tracks: unknown[] = []
  senders: any[] = []
  candidates: unknown[] = []
  onicecandidate: ((e: any) => void) | null = null
  ontrack: ((e: any) => void) | null = null
  onconnectionstatechange: (() => void) | null = null
  onnegotiationneeded: (() => void) | null = null
  constructor(public config: any) { FakePC.made.push(this) }
  private needed() { setTimeout(() => { if (this.signalingState === 'stable') this.onnegotiationneeded?.() }, 0) }
  addTrack(track: unknown) { this.tracks.push(track); const sender = { track }; this.senders.push(sender); this.needed(); return sender }
  removeTrack(sender: any) { this.senders = this.senders.filter((x) => x !== sender); this.needed() }
  getSenders() { return this.senders }
  async setLocalDescription(d?: any) {
    const type = d?.type || (this.signalingState === 'have-remote-offer' ? 'answer' : 'offer')
    const desc = { type, sdp: `${type}-sdp` }
    this.localDescription = { ...desc, toJSON: () => desc }
    this.signalingState = type === 'offer' ? 'have-local-offer' : 'stable'
  }
  async setRemoteDescription(d: any) { this.remoteDescription = d; this.signalingState = d.type === 'offer' ? 'have-remote-offer' : 'stable' }
  async addIceCandidate(c: unknown) { if (!this.remoteDescription) throw new Error('no remote description'); this.candidates.push(c) }
  restartIce() {}
  close() { this.closed = true }
}

let sent: Sent[]
let stopped: number
const track = () => ({ enabled: true, stop: () => { stopped += 1 } })
const deliver = (name: string, value: unknown) => window.dispatchEvent(new CustomEvent('honmaru:jam', { detail: { name, value } }))
const flush = () => new Promise((r) => setTimeout(r, 0))

beforeEach(() => {
  sent = []
  stopped = 0
  FakePC.made = []
  const target = new EventTarget()
  vi.stubGlobal('window', target)
  target.addEventListener('honmaru:jam-send', (e) => sent.push((e as CustomEvent<Sent>).detail))
  const tracks = [track()]
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia: async () => ({ getAudioTracks: () => tracks, getTracks: () => tracks }) } })
  vi.stubGlobal('RTCPeerConnection', FakePC)
  vi.stubGlobal('Audio', class { autoplay = false; srcObject: unknown = null; play() { return Promise.resolve() } })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('JamCall', () => {
  const make = (over: Partial<ConstructorParameters<typeof JamCall>[0]> = {}) => new JamCall({
    channel: 'b:cafe', mode: 'notes', onChange: () => {}, onProblem: () => {}, upload: async () => {}, ...over,
  })

  it('asks to join, then calls everyone already there', async () => {
    const call = make({ muted: true })
    await call.start()
    expect(sent).toEqual([{ type: 'jam_join', payload: { channel: 'b:cafe', mode: 'notes', muted: true } }])
    deliver('jam_joined', { channel: 'b:cafe', peerId: 'me', peers: ['p1', 'p2'], iceServers: [{ urls: ['stun:x'] }], mode: 'full', startedAt: '2026-09-24T01:00:00Z' })
    await flush()
    expect(call.inCall).toBe(true)
    expect(call.mode).toBe('full')
    expect(FakePC.made).toHaveLength(2)
    expect(FakePC.made[0].config).toEqual({ iceServers: [{ urls: ['stun:x'] }] })
    await flush()
    // Each call offers once its voice is added — and says which of its
    // streams are a camera or a screen (none, yet).
    const offers = sent.filter((m) => m.type === 'jam_signal' && m.payload.data.sdp).map((m) => [m.payload.to, m.payload.data.sdp.type])
    expect(offers).toEqual([['p1', 'offer'], ['p2', 'offer']])
    expect(sent.some((m) => m.type === 'jam_signal' && m.payload.data.kinds && m.payload.to === 'p1')).toBe(true)
  })

  it('answers a newcomer\'s offer, then takes their candidates', async () => {
    const call = make()
    await call.start()
    deliver('jam_joined', { channel: 'b:cafe', peerId: 'me', peers: [], iceServers: [] })
    await flush()
    deliver('jam_signal', { from: 'new', data: { sdp: { type: 'offer', sdp: 'their-offer' } } })
    await flush(); await flush()
    const pc = FakePC.made[0]
    expect(pc.remoteDescription).toEqual({ type: 'offer', sdp: 'their-offer' })
    const answers = sent.filter((m) => m.type === 'jam_signal' && m.payload.data.sdp?.type === 'answer')
    expect(answers.map((m) => m.payload.to)).toEqual(['new'])
    deliver('jam_signal', { from: 'new', data: { candidate: { candidate: 'c1' } } })
    await flush()
    expect(pc.candidates).toEqual([{ candidate: 'c1' }])
  })

  it('hangs up on whoever left, and leaves without a trace', async () => {
    const changes: number[] = []
    const call = make({ onChange: () => changes.push(1) })
    await call.start()
    deliver('jam_joined', { channel: 'b:cafe', peerId: 'me', peers: ['p1'], iceServers: [] })
    await flush()
    deliver('jam_state', { channel: 'b:cafe', active: true, participants: [{ peerId: 'me', ref: 'r1', name: 'Me', muted: false, since: '1' }], mode: 'off', recorderPeerId: null, startedAt: '1' })
    await flush()
    expect(FakePC.made[0].closed).toBe(true)
    expect(call.participants.map((p) => p.name)).toEqual(['Me'])
    // Another channel's Jam is not this one.
    deliver('jam_state', { channel: 'b:other', active: true, participants: [], mode: 'off', recorderPeerId: null, startedAt: '1' })
    await flush()
    expect(call.participants.map((p) => p.name)).toEqual(['Me'])

    call.setMuted(true)
    expect(sent.at(-1)).toEqual({ type: 'jam_mute', payload: { muted: true } })
    await call.leave()
    expect(call.ended).toBe(true)
    expect(sent.at(-1)).toEqual({ type: 'jam_leave', payload: {} })
    expect(stopped).toBe(1)
    // Nothing more is heard once gone.
    const before = sent.length
    deliver('jam_signal', { from: 'late', data: { sdp: { type: 'offer', sdp: 'x' } } })
    await flush()
    expect(sent.length).toBe(before)
    expect(changes.length).toBeGreaterThan(0)
  })

  it('joins again on a new socket, and gives up on a refusal', async () => {
    const problems: string[] = []
    const call = make({ onProblem: (m) => problems.push(m) })
    await call.start()
    deliver('jam_joined', { channel: 'b:cafe', peerId: 'me', peers: [], iceServers: [] })
    await flush()
    deliver('reset', {})
    await flush()
    expect(sent.at(-1)).toEqual({ type: 'jam_join', payload: { channel: 'b:cafe', mode: 'notes', muted: false } })
    deliver('jam_error', { channel: 'b:cafe', message: 'A Jam holds 8 people.' })
    await flush()
    expect(problems).toEqual(['A Jam holds 8 people.'])
    expect(call.ended).toBe(true)
  })

  it('adds a camera to a call already running, and says which stream it is', async () => {
    const video = { enabled: true, stop: () => { stopped += 1 }, kind: 'video', onended: null }
    const camera = { id: 'cam-1', getTracks: () => [video], getVideoTracks: () => [video] }
    ;(navigator as any).mediaDevices.getUserMedia = async (c: any) => (c.video ? camera : { getAudioTracks: () => [track()], getTracks: () => [] })
    const call = make()
    await call.start()
    deliver('jam_joined', { channel: 'b:cafe', peerId: 'a', peers: ['b'], iceServers: [] })
    await flush(); await flush()
    const pc = FakePC.made[0]
    pc.signalingState = 'stable'
    await call.setCamera(true)
    await flush(); await flush()
    expect(pc.tracks).toContain(video)
    expect(sent.some((m) => m.type === 'jam_media' && m.payload.video === true)).toBe(true)
    expect(sent.some((m) => m.type === 'jam_signal' && m.payload.data.kinds?.camera === 'cam-1')).toBe(true)
    await call.setCamera(false)
    expect(pc.senders.some((x: any) => x.track === video)).toBe(false)
    expect(sent.at(-1)?.type).toBe('jam_signal')
  })

  it('keeps the live transcript and the reactions it hears', async () => {
    const call = make()
    await call.start()
    deliver('jam_joined', { channel: 'b:cafe', peerId: 'me', peers: [], iceServers: [], transcript: [{ name: 'Mika', text: 'hello', at: '1' }] })
    await flush()
    expect(call.transcript.map((l) => l.text)).toEqual(['hello'])
    deliver('jam_transcript', { channel: 'b:cafe', peerId: 'p1', name: 'Kenji', text: 'we shi', final: false, at: '2' })
    deliver('jam_transcript', { channel: 'b:cafe', peerId: 'p1', name: 'Kenji', text: 'we ship Friday', final: true, at: '3' })
    await flush()
    expect(call.transcript.map((l) => l.text)).toEqual(['hello', 'we ship Friday'])
    expect(call.interim).toEqual({})
    deliver('jam_reaction', { channel: 'b:cafe', peerId: 'p1', name: 'Kenji', emoji: '👏', at: '4' })
    await flush()
    expect(call.reactions.map((r) => r.emoji)).toEqual(['👏'])
    call.react('🎉')
    expect(sent.at(-1)).toEqual({ type: 'jam_react', payload: { emoji: '🎉' } })
  })
})
