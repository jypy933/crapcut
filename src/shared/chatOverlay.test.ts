import { describe, expect, it } from 'vitest'
import type { ChatMessage, Layout } from './types'
import {
  buildChatOverlay,
  chatIn,
  chatOverlayGeometry,
  colorForUser,
  DEFAULT_CHAT_OVERLAY_OPTIONS,
  wrapChatText,
  type ChatOverlayGeometry
} from './chatOverlay'

const msg = (t: number, user: string, text: string): ChatMessage => ({ t, user, text })

const fullGame = { x: 0, y: 0, w: 1, h: 1 }
const blurFill: Layout = { id: 'l1', name: 'Full frame', kind: 'blur_fill', cam: null, game: fullGame }
const camGame: Layout = { id: 'l2', name: 'Cam', kind: 'cam_game', cam: { x: 0.7, y: 0.6, w: 0.3, h: 0.4 }, game: fullGame }
const source = { width: 1920, height: 1080 }

describe('colorForUser', () => {
  it('is stable for the same user, case-insensitively', () => {
    expect(colorForUser('Zap')).toBe(colorForUser('zap'))
    expect(colorForUser('zap')).toBe(colorForUser('ZAP'))
  })
  it('spreads different users across the palette', () => {
    const colors = new Set(['alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'gina', 'hank'].map(colorForUser))
    expect(colors.size).toBeGreaterThan(1)
  })
  it('returns a hex colour', () => {
    expect(colorForUser('someone')).toMatch(/^#[0-9A-Fa-f]{6}$/)
  })
})

describe('chatIn', () => {
  it('windows messages to [from, to)', () => {
    const messages = [msg(0, 'a', 'hi'), msg(10, 'b', 'hey'), msg(20, 'c', 'yo')]
    expect(chatIn(messages, 5, 20).map((m) => m.user)).toEqual(['b'])
    expect(chatIn(messages, 0, 21).map((m) => m.user)).toEqual(['a', 'b', 'c'])
  })
})

describe('wrapChatText', () => {
  it('keeps a short message on one line', () => {
    expect(wrapChatText('KEKW', 20, 2)).toEqual(['KEKW'])
  })
  it('wraps onto a second line when it does not fit', () => {
    const lines = wrapChatText('this message is definitely too long for one line', 20, 2)
    expect(lines.length).toBe(2)
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(24) // a little slack for the "..." marker
  })
  it('truncates with "..." when it still does not fit in the line budget', () => {
    const lines = wrapChatText('one two three four five six seven eight nine ten eleven twelve', 10, 1)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toMatch(/\.\.\.$/)
  })
  it('hard-breaks a single very long word', () => {
    const lines = wrapChatText('a'.repeat(50), 10, 2)
    expect(lines.length).toBeGreaterThan(0)
    for (const l of lines) expect(l.replace(' ...', '').length).toBeLessThanOrEqual(10)
  })
  it('never exceeds the requested number of lines', () => {
    const lines = wrapChatText('word '.repeat(40), 8, 3)
    expect(lines.length).toBeLessThanOrEqual(3)
  })
})

describe('chatOverlayGeometry', () => {
  it('sits inside the frame for both formats', () => {
    for (const format of ['vertical', 'horizontal'] as const) {
      const g = chatOverlayGeometry(format, blurFill, source, 0.72)
      const out = format === 'vertical' ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 }
      expect(g.x).toBeGreaterThanOrEqual(0)
      expect(g.y).toBeGreaterThanOrEqual(0)
      expect(g.x + g.w).toBeLessThanOrEqual(out.width)
      expect(g.y + g.h).toBeLessThanOrEqual(out.height)
      expect(g.maxLines).toBeGreaterThan(0)
    }
  })

  it('starts below the facecam for a cam_game vertical layout', () => {
    const withCam = chatOverlayGeometry('vertical', camGame, source, 0.72)
    const withoutCam = chatOverlayGeometry('vertical', blurFill, source, 0.72)
    expect(withCam.y).toBeGreaterThan(withoutCam.y)
  })

  it('stays above the caption band', () => {
    const g = chatOverlayGeometry('vertical', blurFill, source, 0.72)
    const capTop = 1920 * 0.72
    expect(g.y + g.h).toBeLessThanOrEqual(capTop)
  })

  it('does not shrink for captions when they are off', () => {
    const withCaptions = chatOverlayGeometry('vertical', blurFill, source, 0.3)
    const withoutCaptions = chatOverlayGeometry('vertical', blurFill, source, null)
    expect(withoutCaptions.h).toBeGreaterThanOrEqual(withCaptions.h)
  })

  it('is on the horizontal frame for 16:9', () => {
    const g = chatOverlayGeometry('horizontal', blurFill, source, 0.8)
    expect(g.x + g.w).toBeLessThanOrEqual(1920)
  })
})

describe('buildChatOverlay', () => {
  const geometry: ChatOverlayGeometry = chatOverlayGeometry('vertical', blurFill, source, null)

  it('windows to the clip range', () => {
    const messages = [msg(5, 'a', 'too early'), msg(12, 'b', 'in range'), msg(40, 'c', 'too late')]
    const lines = buildChatOverlay(messages, 10, 30, geometry)
    expect(lines.every((l) => !l.text.includes('too early') && !l.text.includes('too late'))).toBe(true)
    expect(lines.some((l) => l.messageLines.join(' ').includes('in range'))).toBe(true)
  })

  it('spreads messages sharing the same second so they do not appear at once', () => {
    const messages = [msg(10, 'a', 'one'), msg(10, 'b', 'two'), msg(10, 'c', 'three')]
    const lines = buildChatOverlay(messages, 10, 15, geometry)
    const starts = [...new Set(lines.map((l) => l.start))].sort((a, b) => a - b)
    expect(starts.length).toBeGreaterThan(1)
    for (const s of starts) {
      expect(s).toBeGreaterThanOrEqual(0)
      expect(s).toBeLessThan(1)
    }
  })

  it('stacks newest at the bottom and scrolls old ones off after the cap', () => {
    const messages = Array.from({ length: geometry.maxLines + 3 }, (_, i) => msg(10 + i, `user${i}`, `message ${i}`))
    const clipStart = 10
    const clipEnd = clipStart + messages.length + 2
    const lines = buildChatOverlay(messages, clipStart, clipEnd, geometry)
    // By the end of the clip, only the most recent `maxLines` messages are
    // still visible -- the earliest one has scrolled off the stack.
    const finalLines = lines.filter((l) => l.end === clipEnd - clipStart)
    expect(finalLines.length).toBeLessThanOrEqual(geometry.maxLines)
    expect(finalLines.some((l) => l.user === 'user0')).toBe(false)
    // The newest message is present and placed at the bottom-most slot.
    const last = finalLines.filter((l) => l.user === `user${messages.length - 1}`)
    expect(last.length).toBeGreaterThan(0)
    expect(last[0]!.y).toBeCloseTo(geometry.y + geometry.h - geometry.slotHeight, 0)
  })

  it('fades in only the newest (bottom-most) line in each period', () => {
    const messages = [msg(10, 'a', 'one'), msg(11, 'b', 'two')]
    const lines = buildChatOverlay(messages, 10, 13, geometry)
    const bottomY = geometry.y + geometry.h - geometry.slotHeight
    const faded = lines.filter((l) => l.fadeInMs !== null)
    expect(faded.length).toBeGreaterThan(0)
    for (const l of faded) {
      expect(l.y).toBeCloseTo(bottomY, 0)
      expect(l.fadeInMs).toBe(Math.round(DEFAULT_CHAT_OVERLAY_OPTIONS.fadeInSec * 1000))
    }
    for (const l of lines) if (l.y < bottomY - 1) expect(l.fadeInMs).toBeNull()
  })

  it('escapes ASS-special characters in names and messages', () => {
    const messages = [msg(10, 'a{b}', 'hello\\world {oops}')]
    const lines = buildChatOverlay(messages, 10, 12, geometry)
    expect(lines[0]!.text).not.toContain('{b}')
    expect(lines[0]!.text).not.toContain('{oops}')
    expect(lines[0]!.text).toContain('(b)')
  })

  it('returns nothing outside the clip range or with no messages', () => {
    expect(buildChatOverlay([], 0, 10, geometry)).toEqual([])
    expect(buildChatOverlay([msg(100, 'a', 'hi')], 0, 10, geometry)).toEqual([])
  })
})
