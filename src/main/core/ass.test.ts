import { describe, expect, it } from 'vitest'
import { captionAt, clipWords, groupWords } from '@shared/captions'
import { CAPTION_STYLES, captionStyle } from '@shared/captionStyles'
import { buildChatOverlay, chatOverlayGeometry, type ChatOverlayLine } from '@shared/chatOverlay'
import type { ChatMessage, Layout, Word } from '@shared/types'
import { assColor, assEscape, assTime, buildAss, defaultAssStyle, inlineColor, type ChatOverlayAssInput } from './ass'

const w = (t0: number, t1: number, text: string): Word => ({ t0, t1, text })

describe('groupWords', () => {
  it('groups a few words at a time and breaks on punctuation and pauses', () => {
    const words = [w(0, 0.3, 'so'), w(0.3, 0.6, 'this'), w(0.6, 0.9, 'is'), w(0.9, 1.2, 'crazy.'), w(1.3, 1.5, 'wait'), w(3, 3.3, 'what')]
    const groups = groupWords(words)
    expect(groups.map((g) => g.words.map((x) => x.text).join(' '))).toEqual(['so this is', 'crazy.', 'wait', 'what'])
  })
  it('respects the character limit', () => {
    const words = [w(0, 0.3, 'extraordinarily'), w(0.3, 0.6, 'long'), w(0.6, 0.9, 'words')]
    expect(groupWords(words).map((g) => g.words.length)).toEqual([1, 2])
  })
  it('never overlaps groups and lingers briefly', () => {
    const groups = groupWords([w(0, 0.3, 'a'), w(0.3, 0.6, 'b'), w(0.6, 0.9, 'c'), w(0.95, 1.2, 'd'), w(5, 5.2, 'e')])
    for (let i = 1; i < groups.length; i++) expect(groups[i]!.start).toBeGreaterThanOrEqual(groups[i - 1]!.end)
    expect(groups[1]!.end).toBeCloseTo(1.6)
  })
  it('skips empty words', () => {
    expect(groupWords([w(0, 1, '  ')])).toEqual([])
  })
})

describe('captionAt', () => {
  const groups = groupWords([w(0, 0.3, 'one'), w(0.3, 0.6, 'two'), w(0.6, 0.9, 'three'), w(2, 2.3, 'four')])
  it('finds the active word', () => {
    expect(captionAt(groups, 0.35)).toMatchObject({ active: 1 })
    expect(captionAt(groups, 2.1)?.group.words[0]!.text).toBe('four')
    expect(captionAt(groups, 1.6)).toBeNull()
    expect(captionAt(groups, -1)).toBeNull()
  })
})

/** Rounds to milliseconds so float error from time-shifting does not fail an exact match. */
function round(words: Word[]): Word[] {
  return words.map((x) => ({ ...x, t0: Math.round(x.t0 * 1000) / 1000, t1: Math.round(x.t1 * 1000) / 1000 }))
}

describe('clipWords', () => {
  it('shifts to clip time and trims', () => {
    expect(round(clipWords([w(9.7, 10.3, 'apple'), w(11, 11.5, 'banana'), w(30, 30.5, 'cherry')], 10, 20))).toEqual([
      w(0, 0.3, 'apple'),
      w(1, 1.5, 'banana')
    ])
  })
  it('repairs a stretched word using its neighbours before clipping', () => {
    // "mind" really said right at 10.2, but whisper stretched it back to 9.
    const words = [w(8.7, 9, 'surprise!'), w(9, 10.2, 'mind'), w(10.2, 10.3, 'me')]
    expect(round(clipWords(words, 10, 20))).toEqual([w(0, 0.2, 'mind'), w(0.2, 0.3, 'me')])
  })
})

describe('ASS helpers', () => {
  it('formats times and colours', () => {
    expect(assTime(0)).toBe('0:00:00.00')
    expect(assTime(3723.456)).toBe('1:02:03.46')
    expect(assColor('#FFD400')).toBe('&H0000D4FF')
    expect(assColor('#000000', 0x80)).toBe('&H80000000')
    expect(inlineColor('#FFD400')).toBe('&H00D4FF&')
    expect(() => assColor('red')).toThrow()
  })
  it('neutralises override tags and line breaks', () => {
    expect(assEscape('a{\\b1}b\nc\\N')).toBe('a(/b1)b c/N')
  })
})

describe('buildAss', () => {
  const words = [w(0.5, 0.8, 'hello'), w(0.8, 1.1, 'there'), w(1.1, 1.5, 'bro!'), w(3, 3.4, '{evil}')]
  const ass = buildAss(words, defaultAssStyle('vertical', 0.7, true))
  const dialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))

  it('has a header sized for the format', () => {
    expect(ass).toContain('PlayResX: 1080')
    expect(ass).toContain('PlayResY: 1920')
    expect(ass).toContain('Style: Caption,Montserrat Black,88,')
  })
  it('emits one event per word with the word highlighted', () => {
    expect(dialogues).toHaveLength(4)
    expect(dialogues[0]).toContain('0:00:00.50,0:00:00.80')
    expect(dialogues[1]).toContain('HELLO {\\c&H00D4FF&}THERE{\\c&HFFFFFF&} BRO!')
    expect(dialogues[0]).toContain('\\pos(540,1344)')
  })
  it('escapes user text', () => {
    expect(dialogues[3]).toContain('(EVIL)')
    expect(dialogues[3]).not.toContain('{EVIL}')
  })
  it('handles no words', () => {
    expect(buildAss([], defaultAssStyle('horizontal', 0.8, false))).toContain('[Events]')
  })
})

describe('caption style presets', () => {
  it('has 4 presets with distinct looks', () => {
    expect(CAPTION_STYLES).toHaveLength(4)
    expect(new Set(CAPTION_STYLES.map((s) => s.id)).size).toBe(4)
  })

  it('falls back to the clean preset for an unknown id', () => {
    expect(captionStyle('nope').id).toBe('clean')
    expect(captionStyle(undefined).id).toBe('clean')
  })

  it('boxed draws an opaque box instead of an outline', () => {
    const ass = buildAss([w(0, 0.4, 'hey')], defaultAssStyle('vertical', 0.7, false, captionStyle('boxed')))
    const style = ass.split('\n').find((l) => l.startsWith('Style:'))!
    const fields = style.split(',')
    expect(fields[15]).toBe('3') // BorderStyle: opaque box
  })

  it('clean and minimal use a normal outline', () => {
    for (const id of ['clean', 'minimal'] as const) {
      const ass = buildAss([w(0, 0.4, 'hey')], defaultAssStyle('vertical', 0.7, false, captionStyle(id)))
      const fields = ass.split('\n').find((l) => l.startsWith('Style:'))!.split(',')
      expect(fields[15]).toBe('1')
    }
  })

  it('bold pop highlights shouted words and numbers even when not active', () => {
    // All 3 words land in one group (maxWords 3): "we" is active, "100" and
    // "STOP" should stay highlighted as keywords.
    const words = [w(0, 0.3, 'we'), w(0.3, 0.6, '100'), w(0.6, 0.9, 'STOP')]
    const ass = buildAss(words, defaultAssStyle('vertical', 0.7, false, captionStyle('bold')))
    const first = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))[0]!
    expect(first.match(/\\c/g)?.length).toBe(6) // 3 highlighted words, open+close each
  })

  it('clean does not highlight words that are not active', () => {
    const words = [w(0, 0.3, 'we'), w(0.3, 0.6, '100'), w(0.6, 0.9, 'STOP')]
    const ass = buildAss(words, defaultAssStyle('vertical', 0.7, false, captionStyle('clean')))
    const first = ass.split('\n').filter((l) => l.startsWith('Dialogue:'))[0]!
    expect(first.match(/\\c/g)?.length).toBe(2) // only the active word
  })

  it('a style without pop skips the grow-in tag', () => {
    const ass = buildAss([w(0, 0.4, 'hey')], defaultAssStyle('vertical', 0.7, false, captionStyle('minimal')))
    expect(ass).not.toContain('\\fscx88')
  })

  it('a style with pop grows the first word in', () => {
    const ass = buildAss([w(0, 0.4, 'hey')], defaultAssStyle('vertical', 0.7, false, captionStyle('clean')))
    expect(ass).toContain('\\fscx88')
  })
})

describe('chat overlay in the ASS file', () => {
  const chatMsg = (t: number, user: string, text: string): ChatMessage => ({ t, user, text })
  const layout: Layout = { id: 'l', name: 'Full frame', kind: 'blur_fill', cam: null, game: { x: 0, y: 0, w: 1, h: 1 } }
  const source = { width: 1920, height: 1080 }
  const font = { fontName: 'Segoe UI', fontSize: 34 }

  function chatFor(messages: ChatMessage[], clipStart: number, clipEnd: number): ChatOverlayLine[] {
    const geometry = chatOverlayGeometry('vertical', layout, source, 0.72)
    return buildChatOverlay(messages, clipStart, clipEnd, geometry)
  }

  it('adds no chat style or events when there are no lines', () => {
    const ass = buildAss([w(0, 0.4, 'hey')], defaultAssStyle('vertical', 0.7, true), { lines: [], font })
    expect(ass).not.toContain('Style: Chat,')
    expect(ass.split('\n').filter((l) => l.startsWith('Dialogue:'))).toHaveLength(1)
  })

  it('adds a Chat style with an opaque per-line box', () => {
    const lines = chatFor([chatMsg(10, 'zap', 'hello there')], 10, 20)
    const ass = buildAss([], defaultAssStyle('vertical', 0.7, true), { lines, font } satisfies ChatOverlayAssInput)
    const chatStyle = ass.split('\n').find((l) => l.startsWith('Style: Chat,'))!
    expect(chatStyle).toBeDefined()
    expect(chatStyle.split(',')[15]).toBe('3') // BorderStyle: opaque box, like the boxed caption preset
  })

  it('emits one chat Dialogue per placed line, positioned and timed by the overlay layout', () => {
    const lines = chatFor([chatMsg(10, 'zap', 'hello'), chatMsg(11, 'bob', 'world')], 10, 20)
    const ass = buildAss([], defaultAssStyle('vertical', 0.7, true), { lines, font })
    const chatDialogues = ass.split('\n').filter((l) => l.startsWith('Dialogue: 1,'))
    expect(chatDialogues.length).toBe(lines.length)
    for (const line of lines) {
      expect(ass).toContain(`\\pos(${Math.round(line.x)},${Math.round(line.y)})`)
    }
  })

  it('fades in the newest line only', () => {
    const lines = chatFor([chatMsg(10, 'zap', 'hi'), chatMsg(11, 'bob', 'yo')], 10, 20)
    const ass = buildAss([], defaultAssStyle('vertical', 0.7, true), { lines, font })
    expect(ass).toContain('\\fad(')
  })

  it('colours the user name and escapes ASS-special characters', () => {
    const lines = chatFor([chatMsg(10, 'a{b}', 'hi \\world')], 10, 20)
    const ass = buildAss([], defaultAssStyle('vertical', 0.7, true), { lines, font })
    expect(ass).toContain('(b)')
    expect(ass).not.toContain('{b}')
    expect(ass).toMatch(/\\c&H[0-9A-F]{6}&\}a\(b\)/)
  })
})
