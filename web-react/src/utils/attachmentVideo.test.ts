import { afterEach, describe, expect, it, vi } from 'vitest'
import { watchAttachmentVideo, toggleVideoFullscreen } from './attachmentVideo'

class Video extends EventTarget {
  ownerDocument = Object.assign(new EventTarget(), { fullscreenElement: null as Video | null, exitFullscreen: vi.fn(async () => {}) })
  paused = false
  currentTime = 12
  pause = vi.fn(() => { this.paused = true })
  requestFullscreen = vi.fn(async () => {})
  webkitDisplayingFullscreen = false
  webkitEnterFullscreen = vi.fn()
  webkitExitFullscreen = vi.fn()
}
const asVideo = (video: Video) => video as unknown as HTMLVideoElement
const observers: { callback: IntersectionObserverCallback; disconnect: ReturnType<typeof vi.fn> }[] = []
function visibility(index: number, visible: boolean, touching = false) {
  observers[index].callback([{ isIntersecting: visible || touching, intersectionRect: { width: visible ? 100 : 0, height: visible ? 100 : 0 } } as IntersectionObserverEntry], {} as IntersectionObserver)
}
afterEach(() => { vi.unstubAllGlobals(); observers.length = 0 })

describe('attachment video playback', () => {
  function setup() {
    vi.stubGlobal('IntersectionObserver', class {
      constructor(callback: IntersectionObserverCallback) { observers.push({ callback, disconnect: this.disconnect }) }
      observe = vi.fn()
      disconnect = vi.fn()
    })
  }
  it('pauses only other registered attachments across panes, preserving their position', () => {
    setup()
    const main = new Video(), thread = new Video(), jam = new Video()
    const cleanup = [watchAttachmentVideo(asVideo(main)), watchAttachmentVideo(asVideo(thread))]
    thread.dispatchEvent(new Event('play'))
    expect(main.pause).toHaveBeenCalledOnce()
    expect(main.currentTime).toBe(12)
    expect(thread.pause).not.toHaveBeenCalled()
    expect(jam.pause).not.toHaveBeenCalled()
    cleanup.forEach(stop => stop())
  })
  it('pauses when fully clipped, including a zero-area intersection, and never restarts on return', () => {
    setup()
    const video = new Video(), stop = watchAttachmentVideo(asVideo(video))
    visibility(0, true)
    expect(video.pause).not.toHaveBeenCalled()
    visibility(0, false, true)
    expect(video.pause).toHaveBeenCalledOnce()
    visibility(0, true)
    expect(video.pause).toHaveBeenCalledOnce()
    expect(video.currentTime).toBe(12)
    stop()
    expect(observers[0].disconnect).toHaveBeenCalledOnce()
  })
  it.each(['standard', 'safari'])('keeps %s fullscreen playing while clipped and pauses after exit', mode => {
    setup()
    const video = new Video(), stop = watchAttachmentVideo(asVideo(video))
    if (mode === 'standard') video.ownerDocument.fullscreenElement = video
    else video.webkitDisplayingFullscreen = true
    visibility(0, false)
    expect(video.pause).not.toHaveBeenCalled()
    video.ownerDocument.fullscreenElement = null
    video.webkitDisplayingFullscreen = false
    if (mode === 'standard') video.ownerDocument.dispatchEvent(new Event('fullscreenchange'))
    else video.dispatchEvent(new Event('webkitendfullscreen'))
    expect(video.pause).toHaveBeenCalledOnce()
    stop()
  })
  it('coordinates playback even without IntersectionObserver and unregisters replaced players', () => {
    vi.stubGlobal('IntersectionObserver', undefined)
    const old = new Video(), current = new Video()
    const stopOld = watchAttachmentVideo(asVideo(old))
    stopOld()
    old.pause.mockClear()
    const stopCurrent = watchAttachmentVideo(asVideo(current))
    current.dispatchEvent(new Event('play'))
    expect(old.pause).not.toHaveBeenCalled()
    stopCurrent()
  })
})

describe('attachment fullscreen', () => {
  it('uses the standard video API, and exits fullscreen', async () => {
    const video = new Video()
    await toggleVideoFullscreen(asVideo(video))
    expect(video.requestFullscreen).toHaveBeenCalledOnce()
    video.ownerDocument.fullscreenElement = video
    await toggleVideoFullscreen(asVideo(video))
    expect(video.ownerDocument.exitFullscreen).toHaveBeenCalledOnce()
  })
  it('uses native Safari video fullscreen when the standard API is unavailable', async () => {
    const video = new Video()
    Object.assign(video, { requestFullscreen: undefined })
    await toggleVideoFullscreen(asVideo(video))
    expect(video.webkitEnterFullscreen).toHaveBeenCalledOnce()
    video.webkitDisplayingFullscreen = true
    await toggleVideoFullscreen(asVideo(video))
    expect(video.webkitExitFullscreen).toHaveBeenCalledOnce()
  })
  it('propagates rejected requests so the control can explain failure', async () => {
    const video = new Video()
    video.requestFullscreen.mockRejectedValue(new Error('denied'))
    await expect(toggleVideoFullscreen(asVideo(video))).rejects.toThrow('denied')
  })
})
