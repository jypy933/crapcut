import { describe, expect, it } from 'vitest'
import type { ChatMessage, Layout } from './types'
import {
  buildChatOverlay,
  chatBoxNorm,
  chatOverlayGeometry,
  chatPosition,
  DEFAULT_CHAT_OVERLAY_OPTIONS,
  placeChatBox,
  resetChatPosition,
  withChatPosition
} from './chatOverlay'
import { safeArea } from './overlayPosition'

const msg = (t: number, user: string, text: string): ChatMessage => ({ t, user, text })
const blurFill: Layout = { id: 'l1', name: 'Full frame', kind: 'blur_fill', cam: null, game: { x: 0, y: 0, w: 1, h: 1 } }
const source = { width: 1920, height: 1080 }

describe('a dragged chat box', () => {
  const opts = DEFAULT_CHAT_OVERLAY_OPTIONS
  const out = { vertical: { width: 1080, height: 1920 }, horizontal: { width: 1920, height: 1080 } }

  it('sits at the saved top-left corner, in whole pixels, for both formats', () => {
    for (const format of ['vertical', 'horizontal'] as const) {
      const g = chatOverlayGeometry(format, blurFill, source, 0.72, opts, { x: 0.1, y: 0.3 })
      expect(g.x).toBe(Math.round(0.1 * out[format].width))
      expect(g.y).toBe(Math.round(0.3 * out[format].height))
    }
  })

  it('keeps the whole box inside the frame', () => {
    for (const format of ['vertical', 'horizontal'] as const) {
      const g = chatOverlayGeometry(format, blurFill, source, null, opts, { x: 5, y: 5 })
      expect(g.x + g.w).toBeLessThanOrEqual(out[format].width)
      expect(g.y + g.h).toBeLessThanOrEqual(out[format].height)
      const low = chatOverlayGeometry(format, blurFill, source, null, opts, { x: -5, y: -5 })
      expect(low.x).toBe(0)
      expect(low.y).toBe(0)
    }
  })

  it('keeps its full size once placed, whatever the captions do', () => {
    const placed = chatOverlayGeometry('vertical', blurFill, source, 0.3, opts, { x: 0.1, y: 0.1 })
    const free = chatOverlayGeometry('vertical', blurFill, source, null, opts, { x: 0.1, y: 0.1 })
    expect(placed).toEqual(free)
    expect(placed.h).toBeGreaterThanOrEqual(chatOverlayGeometry('vertical', blurFill, source, 0.3).h)
  })

  it('is the default place without a saved position', () => {
    expect(chatOverlayGeometry('vertical', blurFill, source, 0.72, opts, null)).toEqual(chatOverlayGeometry('vertical', blurFill, source, 0.72))
  })

  it('moves the burned-in lines with the box', () => {
    const g = chatOverlayGeometry('vertical', blurFill, source, null, opts, { x: 0.05, y: 0.4 })
    const lines = buildChatOverlay([msg(10, 'zap', 'hi')], 10, 20, g)
    expect(lines[0]!.x).toBe(g.x + g.w)
    expect(lines[0]!.y).toBeGreaterThanOrEqual(g.y)
    expect(lines[0]!.y + g.slotHeight).toBeLessThanOrEqual(g.y + g.h)
  })

  it('reads the box back as fractions of the frame', () => {
    const g = chatOverlayGeometry('vertical', blurFill, source, null, opts, { x: 0.1, y: 0.3 })
    const n = chatBoxNorm(g, 'vertical')
    expect(n.x).toBeCloseTo(0.1, 3)
    expect(n.y).toBeCloseTo(0.3, 3)
    expect(n.w).toBeCloseTo(g.w / 1080)
  })
})

describe('saved chat positions', () => {
  it('keeps one position per format', () => {
    const saved = withChatPosition(withChatPosition(undefined, 'vertical', { x: 0.123456, y: 0.2 }), 'horizontal', { x: 0.5, y: 0.5 })
    expect(chatPosition(saved, 'vertical')).toEqual({ x: 0.1235, y: 0.2 })
    expect(chatPosition(saved, 'horizontal')).toEqual({ x: 0.5, y: 0.5 })
  })
  it('is null (the default place) for a clip with none saved', () => {
    expect(chatPosition(undefined, 'vertical')).toBeNull()
    expect(chatPosition({}, 'horizontal')).toBeNull()
  })
  it('resets one format and leaves the other', () => {
    const saved = withChatPosition(withChatPosition(undefined, 'vertical', { x: 0.1, y: 0.2 }), 'horizontal', { x: 0.5, y: 0.5 })
    expect(resetChatPosition(saved, 'vertical')).toEqual({ horizontal: { x: 0.5, y: 0.5 } })
    expect(resetChatPosition(resetChatPosition(saved, 'vertical'), 'horizontal')).toEqual({})
  })
})

describe('placeChatBox', () => {
  const box = { w: 0.5, h: 0.2 }
  const home = { x: 0.455, y: 0.05 }

  it('follows the pointer when nothing is near', () => {
    expect(placeChatBox({ x: 0.2, y: 0.25 }, box, 'vertical', home)).toEqual({ pos: { x: 0.2, y: 0.25 }, guideX: null, guideY: null })
  })
  it('keeps the box inside the frame', () => {
    expect(placeChatBox({ x: 3, y: -3 }, box, 'vertical', home, { snap: false }).pos).toEqual({ x: 0.5, y: 0 })
  })
  it('snaps to its default place', () => {
    const p = placeChatBox({ x: 0.46, y: 0.06 }, box, 'vertical', home)
    expect(p.pos).toEqual(home)
    expect(p.guideX).toBe(home.x)
    expect(p.guideY).toBe(home.y)
  })
  it('snaps its edges to the safe area of 9:16 and its centre to the middle', () => {
    const area = safeArea('vertical')
    const left = placeChatBox({ x: area.left + 0.01, y: 0.4 }, box, 'vertical', home)
    expect(left.pos.x).toBe(area.left)
    const right = placeChatBox({ x: area.right - box.w - 0.01, y: 0.4 }, box, 'vertical', home)
    expect(right.pos.x).toBeCloseTo(area.right - box.w)
    expect(right.guideX).toBe(area.right)
    const middle = placeChatBox({ x: 0.5 - box.w / 2 + 0.01, y: 0.4 }, box, 'vertical', home)
    expect(middle.guideX).toBe(0.5)
    const bottom = placeChatBox({ x: 0.2, y: area.bottom - box.h - 0.01 }, box, 'vertical', home)
    expect(bottom.guideY).toBe(area.bottom)
  })
  it('moves freely when snapping is off', () => {
    expect(placeChatBox({ x: 0.46, y: 0.06 }, box, 'vertical', home, { snap: false })).toEqual({ pos: { x: 0.46, y: 0.06 }, guideX: null, guideY: null })
  })
})
