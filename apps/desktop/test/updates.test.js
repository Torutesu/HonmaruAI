import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
const mocks = vi.hoisted(() => ({ show: vi.fn(), check: vi.fn(), install: vi.fn(), handlers: {} }))
vi.mock('electron', () => ({ dialog: { showMessageBox: mocks.show } }))
vi.mock('electron-updater', () => ({ default: { autoUpdater: {
  on: (name, fn) => { mocks.handlers[name] = fn }, checkForUpdates: mocks.check, quitAndInstall: mocks.install,
} } }))
import { startUpdates } from '../src/updates.js'
const options = () => ({ appName: 'Honmaru AI', version: '0.1.2', japanese: true, getWindow: () => null, beforeRestart: vi.fn() })
beforeEach(() => { vi.useFakeTimers(); vi.clearAllMocks(); mocks.show.mockResolvedValue({response:1}); mocks.check.mockResolvedValue({updateInfo:{version:'0.1.2'}}) })
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers() })
describe('manual updates', () => {
  it('shows current version even after a background check', async () => {
    const service = await startUpdates(options()); await service.check(true)
    expect(mocks.show).toHaveBeenCalledWith(expect.objectContaining({message:'最新バージョンです',detail:'現在のバージョン: 0.1.2'}))
  })
  it('reports network failures on manual checks', async () => {
    mocks.check.mockRejectedValue(new Error('offline'))
    const service = await startUpdates(options()); await service.check(true)
    expect(mocks.show).toHaveBeenCalledWith(expect.objectContaining({type:'error'}))
  })
  it('lets the user install an already downloaded update after choosing Later', async () => {
    const opts = options(); const service = await startUpdates(opts)
    mocks.handlers['update-downloaded']({version:'0.1.3'})
    await Promise.resolve(); expect(mocks.install).not.toHaveBeenCalled()
    mocks.show.mockResolvedValue({response:0}); await service.check(true)
    expect(opts.beforeRestart).toHaveBeenCalledOnce(); expect(mocks.install).toHaveBeenCalledOnce()
  })
  it('reports a download failure after a successful manual check without exposing its URL', async () => {
    let rejectDownload
    const downloadPromise = new Promise((_, reject) => { rejectDownload = reject })
    mocks.check.mockResolvedValue({updateInfo:{version:'0.1.3'},downloadPromise})
    const service = await startUpdates(options()); await service.check(true)
    rejectDownload(new Error('https://private.example/?token=secret'))
    await vi.runAllTicks(); await Promise.resolve(); await Promise.resolve()
    expect(mocks.show).toHaveBeenCalledWith(expect.objectContaining({message:'アップデートを完了できませんでした'}))
    expect(JSON.stringify(mocks.show.mock.calls)).not.toContain('secret')
  })
  it('reports install errors and rechecks instead of repeatedly offering the failed download', async () => {
    const service = await startUpdates(options())
    mocks.handlers['update-downloaded']({version:'0.1.3'})
    await Promise.resolve()
    mocks.show.mockResolvedValue({response:0})
    await service.check(true)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    mocks.handlers.error(new Error('installation refused'))
    await Promise.resolve()
    expect(mocks.show).toHaveBeenCalledWith(expect.objectContaining({message:'アップデートを完了できませんでした'}))
    mocks.check.mockClear()
    await service.check(true)
    expect(mocks.check).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
