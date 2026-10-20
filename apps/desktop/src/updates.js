import { dialog } from 'electron'

const CHECK_EVERY_MS = 6 * 60 * 60 * 1000

export async function startUpdates({ appName, getWindow, beforeRestart, version, japanese = false }) {
  const { default: updater } = await import('electron-updater')
  const { autoUpdater } = updater
  autoUpdater.autoDownload = true
  autoUpdater.autoInstallOnAppQuit = true
  autoUpdater.allowPrerelease = false
  let pending = null
  let downloaded = null
  let installing = false
  let failureShown = false
  const show = (options) => {
    const win = getWindow()
    return win ? dialog.showMessageBox(win, options) : dialog.showMessageBox(options)
  }
  const ready = async () => {
    const response = await show({
      type: 'info', title: appName,
      message: japanese ? `${appName} ${downloaded.version} をインストールできます` : `${appName} ${downloaded.version} is ready`,
      detail: japanese ? '再起動して更新します。後で更新する場合は、次回アプリ終了時に適用されます。' : 'Restart to update, or install when you next quit the app.',
      buttons: japanese ? ['再起動して更新', '後で'] : ['Restart and update', 'Later'],
      defaultId: 0, cancelId: 1, noLink: true,
    })
    if (response.response === 0) {
      failureShown = false
      installing = true
      try { beforeRestart(); autoUpdater.quitAndInstall() }
      catch { await failed() }
    }
  }
  const failed = async () => {
    installing = false
    downloaded = null
    if (failureShown) return
    failureShown = true
    await show({ type: 'error', title: appName,
      message: japanese ? 'アップデートを完了できませんでした' : 'Could not finish the update',
      detail: japanese ? '現在のバージョンを引き続き使えます。アプリのメニューからアップデートを再確認してください。' : 'You can keep using the current version. Check for updates again from the app menu.',
    })
  }
  autoUpdater.on('error', error => {
    console.warn('Update check failed:', error?.message || error)
    if (installing) void failed().catch(console.warn)
  })
  autoUpdater.on('update-downloaded', info => { downloaded = info; void ready().catch(console.warn) })
  const check = async (manual = false) => {
    if (manual) failureShown = false
    if (manual && downloaded) return ready()
    if (!pending) {
      pending = autoUpdater.checkForUpdates()
      pending.finally(() => { pending = null }).catch(() => {})
    }
    try {
      const result = await pending
      if (manual && result?.downloadPromise) void result.downloadPromise.catch(() => failed()).catch(console.warn)
      if (!manual || downloaded) return
      const next = result?.updateInfo?.version
      await show({ type: 'info', title: appName,
        message: result?.downloadPromise && next
          ? (japanese ? `バージョン ${next} をダウンロードしています` : `Downloading version ${next}`)
          : (japanese ? '最新バージョンです' : 'You’re up to date'),
        detail: japanese ? `現在のバージョン: ${version}` : `Current version: ${version}`,
      })
    } catch (error) {
      if (manual) await show({ type: 'error', title: appName,
        message: japanese ? 'アップデートを確認できませんでした' : 'Could not check for updates',
        detail: japanese ? 'インターネット接続を確認して、もう一度お試しください。' : 'Check your internet connection and try again.',
      })
    }
  }
  void check()
  setInterval(() => { void check() }, CHECK_EVERY_MS).unref?.()
  return { check }
}
