// A Jam through the SFU (Cloudflare Realtime), from this browser: one
// connection instead of one per person. This browser pushes its own tracks
// — its voice, and a camera or a screen while they are on — once, and pulls
// each other person's. The relay carries the requests (`jam_sfu`), so the
// app's secret never reaches a browser.
//
// Each track keeps its name ("audio", "camera", "screen") for the whole
// call: a camera switched off sends nothing on its track, and switched on
// again reuses it, so nothing has to be negotiated again.

export type SfuTrackName = 'audio' | 'camera' | 'screen'

export interface SfuRemoteTrack { peerId: string; trackName: SfuTrackName; track: MediaStreamTrack }

type Ask = (op: string, payload: Record<string, unknown>) => Promise<Record<string, any>>

export class SfuLink {
  readonly pc: RTCPeerConnection
  private ask: Ask
  private queue: Promise<unknown> = Promise.resolve()
  private sending = new Map<SfuTrackName, RTCRtpTransceiver>()
  /// `peerId/trackName` already asked for, so a track is pulled once.
  private pulled = new Set<string>()
  /// mid → whose track arrives on it.
  private owners = new Map<string, { peerId: string; trackName: SfuTrackName }>()
  private onTrack: (t: SfuRemoteTrack) => void
  closed = false

  constructor(iceServers: RTCIceServer[], ask: Ask, onTrack: (t: SfuRemoteTrack) => void) {
    this.ask = ask
    this.onTrack = onTrack
    this.pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' })
    this.pc.ontrack = (e) => {
      const owner = e.transceiver?.mid ? this.owners.get(e.transceiver.mid) : undefined
      if (owner) this.onTrack({ ...owner, track: e.track })
    }
  }

  /// One negotiation at a time: the SFU and this browser take turns.
  private serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.queue.then(work, work)
    this.queue = next.catch(() => undefined)
    return next
  }

  /// Send a track under its name; a second time, the same track slot is
  /// reused (or emptied, with null) without asking the SFU again.
  publish(trackName: SfuTrackName, track: MediaStreamTrack | null, stream?: MediaStream): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return
      const existing = this.sending.get(trackName)
      if (existing) { await existing.sender.replaceTrack(track).catch(() => {}); return }
      if (!track) return
      const transceiver = this.pc.addTransceiver(track, { direction: 'sendonly', ...(stream ? { streams: [stream] } : {}) })
      this.sending.set(trackName, transceiver)
      await this.pc.setLocalDescription(await this.pc.createOffer())
      const answer = await this.ask('push', { sdp: this.pc.localDescription?.sdp, tracks: [{ mid: transceiver.mid, trackName }] })
      if (answer.error || !answer.sdp) throw new Error(answer.error || 'The call server did not answer.')
      await this.pc.setRemoteDescription({ type: 'answer', sdp: answer.sdp })
    })
  }

  /// Pull what the others publish that this browser does not have yet.
  pull(others: Array<{ peerId: string; tracks?: string[] }>): Promise<void> {
    return this.serial(async () => {
      if (this.closed) return
      const wanted: Array<{ peerId: string; trackName: SfuTrackName }> = []
      for (const o of others) {
        for (const name of o.tracks || []) {
          const key = `${o.peerId}/${name}`
          if (this.pulled.has(key) || !['audio', 'camera', 'screen'].includes(name)) continue
          this.pulled.add(key)
          wanted.push({ peerId: o.peerId, trackName: name as SfuTrackName })
        }
      }
      if (!wanted.length) return
      const out = await this.ask('pull', { tracks: wanted })
      if (out.error) { for (const w of wanted) this.pulled.delete(`${w.peerId}/${w.trackName}`); throw new Error(out.error) }
      for (const t of (out.tracks || []) as Array<{ mid: string | null; peerId: string | null; trackName: SfuTrackName; error: string | null }>) {
        if (t.mid && t.peerId && !t.error) this.owners.set(t.mid, { peerId: t.peerId, trackName: t.trackName })
        else if (t.peerId) this.pulled.delete(`${t.peerId}/${t.trackName}`)
      }
      if (out.renegotiate && out.sdp) {
        await this.pc.setRemoteDescription({ type: 'offer', sdp: out.sdp })
        await this.pc.setLocalDescription(await this.pc.createAnswer())
        const done = await this.ask('renegotiate', { sdp: this.pc.localDescription?.sdp })
        if (done.error) throw new Error(done.error)
      }
    })
  }

  /// Someone gone: what came from them is forgotten, so coming back pulls anew.
  forget(peerId: string): void {
    for (const key of [...this.pulled]) if (key.startsWith(`${peerId}/`)) this.pulled.delete(key)
    for (const [mid, o] of [...this.owners]) if (o.peerId === peerId) this.owners.delete(mid)
  }

  replaceAudio(track: MediaStreamTrack): Promise<void> {
    return this.publish('audio', track)
  }

  close(): void {
    this.closed = true
    try { this.pc.close() } catch { /* already */ }
  }
}
