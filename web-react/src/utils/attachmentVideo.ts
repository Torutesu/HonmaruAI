type SafariVideo = HTMLVideoElement & {
  webkitDisplayingFullscreen?: boolean
  webkitEnterFullscreen?: () => void
  webkitExitFullscreen?: () => void
}

// Only message attachment videos register here; Jam/call video stays independent.
const attachments = new Set<HTMLVideoElement>()
const fullscreen = (video: SafariVideo) => video.ownerDocument.fullscreenElement === video || !!video.webkitDisplayingFullscreen

export function watchAttachmentVideo(video: HTMLVideoElement): () => void {
  attachments.add(video)
  let visible = true
  const pauseIfHidden = () => { if (!visible && !fullscreen(video) && !video.paused) video.pause() }
  const play = () => {
    for (const other of attachments) if (other !== video && !other.paused) other.pause()
    pauseIfHidden()
  }
  video.addEventListener('play', play)
  video.addEventListener('webkitendfullscreen', pauseIfHidden)
  video.ownerDocument.addEventListener('fullscreenchange', pauseIfHidden)
  // The viewport root also clips against each ancestor scroll container.
  const observer = typeof IntersectionObserver === 'undefined' ? null : new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting && entry.intersectionRect.width > 0 && entry.intersectionRect.height > 0
    pauseIfHidden()
  })
  observer?.observe(video)
  return () => {
    observer?.disconnect()
    video.removeEventListener('play', play)
    video.removeEventListener('webkitendfullscreen', pauseIfHidden)
    video.ownerDocument.removeEventListener('fullscreenchange', pauseIfHidden)
    attachments.delete(video)
    if (!video.paused) video.pause()
  }
}

export async function toggleVideoFullscreen(video: SafariVideo): Promise<void> {
  if (video.ownerDocument.fullscreenElement === video) await video.ownerDocument.exitFullscreen()
  else if (video.webkitDisplayingFullscreen) video.webkitExitFullscreen?.()
  else if (video.requestFullscreen) await video.requestFullscreen()
  else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen()
  else throw new Error('Fullscreen is unavailable')
}
