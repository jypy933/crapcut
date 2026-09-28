import { describe, expect, it } from 'vitest'
import { resolveAutostart } from './autostart'

describe('resolveAutostart', () => {
  it('defaults to off when nothing is watched and the user has not chosen', () => {
    expect(resolveAutostart(null, false)).toBe(false)
  })

  it('defaults to on while a channel is watched and the user has not chosen', () => {
    expect(resolveAutostart(null, true)).toBe(true)
  })

  it('follows the channel watch on and off until the user chooses', () => {
    expect(resolveAutostart({ userSet: false, enabled: true }, false)).toBe(false)
    expect(resolveAutostart({ userSet: false, enabled: false }, true)).toBe(true)
  })

  it('respects an explicit choice regardless of the channel watch', () => {
    expect(resolveAutostart({ userSet: true, enabled: true }, false)).toBe(true)
    expect(resolveAutostart({ userSet: true, enabled: false }, true)).toBe(false)
  })
})
