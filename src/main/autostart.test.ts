// Exercises AutostartManager with a fake `apply` so no test ever touches the
// real Windows registry (setLoginItemSettings is never called for real here).

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Store } from './store'

// autostart.ts imports `app` from 'electron' only for its default `apply`,
// which every test below overrides; mocked here so importing it never risks
// touching the real registry.
vi.mock('electron', () => ({ app: { setLoginItemSettings: vi.fn(), isPackaged: false } }))

const { AutostartManager, HIDDEN_START_ARG } = await import('./autostart')

let dir = ''
let store: Store

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'crapcut-autostart-'))
  store = new Store(join(dir, 'db.sqlite'))
})

afterEach(() => {
  store.close()
  rmSync(dir, { recursive: true, force: true })
})

function manager(channelWatched: () => boolean, apply = vi.fn(), packaged = () => true) {
  return { mgr: new AutostartManager(store, channelWatched, apply, packaged), apply }
}

describe('AutostartManager', () => {
  it('does nothing to the OS in a dev (unpackaged) run', () => {
    const { mgr, apply } = manager(() => true, vi.fn(), () => false)
    mgr.sync()
    expect(apply).not.toHaveBeenCalled()
  })

  it('is off by default with no channel watched', () => {
    const { mgr } = manager(() => false)
    expect(mgr.status()).toEqual({ enabled: false, userSet: false })
  })

  it('turns on by default while a channel is watched, hidden in the tray', () => {
    const { mgr, apply } = manager(() => true)
    expect(mgr.status()).toEqual({ enabled: true, userSet: false })
    mgr.sync()
    expect(apply).toHaveBeenCalledWith({ openAtLogin: true, args: [HIDDEN_START_ARG] })
  })

  it('turns off again once the channel watch stops, if the user never chose', () => {
    let watched = true
    const { mgr, apply } = manager(() => watched)
    mgr.sync()
    watched = false
    mgr.sync()
    expect(apply).toHaveBeenLastCalledWith({ openAtLogin: false })
  })

  it('remembers an explicit choice even after the channel watch changes', () => {
    let watched = false
    const { mgr, apply } = manager(() => watched)
    mgr.setEnabled(true)
    expect(apply).toHaveBeenLastCalledWith({ openAtLogin: true, args: [HIDDEN_START_ARG] })
    watched = true
    mgr.sync()
    expect(apply).toHaveBeenLastCalledWith({ openAtLogin: true, args: [HIDDEN_START_ARG] })

    mgr.setEnabled(false)
    expect(apply).toHaveBeenLastCalledWith({ openAtLogin: false })
    watched = true
    mgr.sync()
    expect(mgr.status()).toEqual({ enabled: false, userSet: true })
    expect(apply).toHaveBeenLastCalledWith({ openAtLogin: false })
  })
})
