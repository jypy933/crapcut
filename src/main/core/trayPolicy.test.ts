import { describe, expect, it } from 'vitest'
import { shouldHideOnClose } from './trayPolicy'

describe('shouldHideOnClose', () => {
  it('lets the window close when nothing needs the app open', () => {
    expect(shouldHideOnClose({ jobRunning: false, exportRunning: false, channelWatched: false })).toBe(false)
  })

  it('hides while a job is running', () => {
    expect(shouldHideOnClose({ jobRunning: true, exportRunning: false, channelWatched: false })).toBe(true)
  })

  it('hides while an export is running', () => {
    expect(shouldHideOnClose({ jobRunning: false, exportRunning: true, channelWatched: false })).toBe(true)
  })

  it('hides while a channel is watched', () => {
    expect(shouldHideOnClose({ jobRunning: false, exportRunning: false, channelWatched: true })).toBe(true)
  })
})
