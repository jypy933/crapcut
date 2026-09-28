import { describe, expect, it } from 'vitest'
import { parseChatLine, parseChatLog } from './chat'

describe('parseChatLine', () => {
  it('parses a normal line', () => {
    expect(parseChatLine('[0:00:05] passmetheglue: Pog ?')).toEqual({ t: 5, user: 'passmetheglue', text: 'Pog ?' })
  })
  it('handles long streams and colons in the message', () => {
    expect(parseChatLine('[12:03:09] someone: time is 12:30: ok')).toEqual({
      t: 12 * 3600 + 189,
      user: 'someone',
      text: 'time is 12:30: ok'
    })
  })
  it('handles non-latin names and empty messages', () => {
    expect(parseChatLine('[0:00:17] 해달서준: PepegaPls')).toMatchObject({ user: '해달서준' })
    expect(parseChatLine('[0:00:17] a:')).toMatchObject({ user: 'a', text: '' })
  })
  it('rejects junk', () => {
    expect(parseChatLine('')).toBeNull()
    expect(parseChatLine('[STATUS] - Downloading 5%')).toBeNull()
    expect(parseChatLine('[0:0:05] a: b')).toBeNull()
  })
})

describe('parseChatLog', () => {
  it('drops bots and junk, keeps order', () => {
    const log = [
      '[0:00:01] a: hi',
      '[0:00:02] Nightbot: follow the socials',
      'garbage',
      '[0:00:03] Fossabot: prediction won',
      '[0:00:04] b: KEKW'
    ].join('\r\n')
    expect(parseChatLog(log).map((m) => m.user)).toEqual(['a', 'b'])
  })
})
