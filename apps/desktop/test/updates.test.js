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
})
