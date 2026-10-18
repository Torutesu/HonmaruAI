// Sharing a screen in a Jam call. A page's getDisplayMedia() reaches the
// shell, which has no picker of its own: macOS 15 and later show the
// system's, everywhere else this app asks which screen or window to share.
// Only the app's own pages may ask, and nothing is shared that was not
// chosen.
//
// Pure: no Electron here (test/capture.test.js).

/// Whether a request to share the screen comes from the app's own page.
/// `request` is Electron's display media request: the frame that asked,
/// and the origin it was at.
export function captureAllowed(request, appOrigin) {
  const from = request?.securityOrigin || request?.frame?.url || ''
  try { return new URL(from).origin === appOrigin } catch { return false }
}

/// What the macOS screen recording permission says about asking: a person
/// who turned it off has to turn it on in System Settings, as the app cannot
/// ask again. Anything else lets the system ask, or capture.
export function captureBlocked(status) {
  return status === 'denied' || status === 'restricted'
}

/// Where System Settings lets a person allow the app to record the screen.
export const SCREEN_SETTINGS = 'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'

/// The question: every screen, then every window, by name, and Cancel last.
/// `sources` are desktopCapturer's. `pick(response)` is the one chosen, or
/// null for Cancel or a dialog closed without an answer.
export function captureChoices(sources, { japanese = false } = {}) {
  const list = Array.isArray(sources) ? sources.filter((s) => s && s.id) : []
  const screens = list.filter((s) => String(s.id).startsWith('screen:'))
  const windows = list.filter((s) => !String(s.id).startsWith('screen:'))
  const offered = [...screens, ...windows]
  const named = (s, i) => {
    const name = String(s.name || '').trim()
    if (name) return name
    if (String(s.id).startsWith('screen:')) return japanese ? `画面 ${i + 1}` : `Screen ${i + 1}`
    return japanese ? '名前のないウインドウ' : 'Untitled window'
  }
  const buttons = [...offered.map(named), japanese ? 'キャンセル' : 'Cancel']
  return {
    sources: offered,
    options: {
      type: 'none',
      title: japanese ? '画面を共有' : 'Share your screen',
      message: japanese ? '共有する画面かウインドウを選んでください' : 'Choose a screen or window to share',
      detail: japanese ? 'Jam の参加者全員に表示されます。' : 'Everyone in the Jam will see it.',
      buttons,
      defaultId: offered.length ? 0 : buttons.length - 1,
      cancelId: buttons.length - 1,
      noLink: false,
    },
    pick: (response) => (Number.isInteger(response) && response >= 0 && response < offered.length ? offered[response] : null),
  }
}

/// What the macOS dialog says when screen recording is off for the app.
export function captureBlockedMessage({ appName = 'Honmaru AI', japanese = false } = {}) {
  return japanese
    ? {
        type: 'info',
        title: appName,
        message: `${appName} には画面収録の許可がありません`,
        detail: `システム設定の「プライバシーとセキュリティ」>「画面収録とシステムオーディオ録音」で ${appName} をオンにしてから、もう一度共有してください。`,
        buttons: ['システム設定を開く', 'キャンセル'],
        defaultId: 0,
        cancelId: 1,
      }
    : {
        type: 'info',
        title: appName,
        message: `${appName} is not allowed to record the screen`,
        detail: `Turn on ${appName} in System Settings > Privacy & Security > Screen & System Audio Recording, then share again.`,
        buttons: ['Open System Settings', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      }
}
