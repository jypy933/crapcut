import { describe, expect, it } from 'vitest'
import {
  camAspectRange,
  clampRect,
  constrainCam,
  dragLayout,
  dragRect,
  duplicateLayout,
  fitRectAspect,
  gameSlotAspect,
  layoutPlan,
  MIN_RECT,
  newLayout,
  normalizeLayout,
  reaspectRect,
  rectAspect,
  roundRect,
  stackHeights,
  toPixels,
  verticalGeometry,
  withKind
} from './layoutGeometry'
import type { Layout, Rect } from './types'

const src = { width: 1920, height: 1080 }
const FULL: Rect = { x: 0, y: 0, w: 1, h: 1 }
const camGame: Layout = { id: 'l1', name: 'Cam', kind: 'cam_game', cam: { x: 0.72, y: 0.62, w: 0.26, h: 0.34 }, game: FULL }
const inFrame = (r: Rect): boolean => r.x >= -1e-9 && r.y >= -1e-9 && r.x + r.w <= 1 + 1e-9 && r.y + r.h <= 1 + 1e-9

describe('clampRect / roundRect', () => {
  it('keeps a rect inside the frame and above the minimum size', () => {
    expect(clampRect({ x: 0.9, y: -0.2, w: 0.4, h: 0.001 })).toEqual({ x: 0.6, y: 0, w: 0.4, h: MIN_RECT })
    expect(clampRect({ x: 0, y: 0, w: 3, h: 3 })).toEqual(FULL)
  })
  it('rounds to four decimals', () => {
    expect(roundRect({ x: 0.123456, y: 0.5, w: 0.33333333, h: 1 })).toEqual({ x: 0.1235, y: 0.5, w: 0.3333, h: 1 })
  })
})

describe('aspect helpers', () => {
  it('measures a normalised rect in source pixels', () => {
    expect(rectAspect(FULL, src)).toBeCloseTo(16 / 9, 6)
    expect(rectAspect({ x: 0, y: 0, w: 0.5, h: 1 }, src)).toBeCloseTo(8 / 9, 6)
  })
  it('fits an aspect inside a rect, centred', () => {
    const r = fitRectAspect(FULL, 9 / 16, src)
    expect(rectAspect(r, src)).toBeCloseTo(9 / 16, 6)
    expect(r.h).toBeCloseTo(1, 6)
    expect(r.x + r.w / 2).toBeCloseTo(0.5, 6)
    const wide = fitRectAspect({ x: 0.1, y: 0.2, w: 0.2, h: 0.6 }, 16 / 9, src)
    expect(wide.w).toBeCloseTo(0.2, 6)
    expect(rectAspect(wide, src)).toBeCloseTo(16 / 9, 6)
    expect(wide.y + wide.h / 2).toBeCloseTo(0.5, 6)
  })
  it('changes a rect aspect around its centre and keeps it in the frame', () => {
    const r = reaspectRect({ x: 0.4, y: 0.4, w: 0.2, h: 0.2 }, 2, src)
    expect(rectAspect(r, src)).toBeCloseTo(2, 6)
    expect(r.w).toBeCloseTo(0.2, 6)
    expect(r.x + r.w / 2).toBeCloseTo(0.5, 6)
    // At the frame's edge it is pulled inside, and when too big it shrinks to fit.
    expect(inFrame(reaspectRect({ x: 0.85, y: 0.85, w: 0.15, h: 0.15 }, 0.5, src))).toBe(true)
    const big = reaspectRect(FULL, 0.5, src)
    expect(inFrame(big)).toBe(true)
    expect(rectAspect(big, src)).toBeCloseTo(0.5, 6)
  })
})

describe('facecam aspect', () => {
  it('spans the slots the stacked cam can have (a quarter to 45% of the height)', () => {
    const { min, max } = camAspectRange()
    expect(min).toBeCloseTo(1.25, 6)
    expect(max).toBeCloseTo(2.25, 6)
  })
  it('leaves an in-range cam alone and narrows a too-tall or too-wide one', () => {
    expect(constrainCam(camGame.cam!, src)).toEqual(camGame.cam)
    const tall = constrainCam({ x: 0.4, y: 0.1, w: 0.1, h: 0.6 }, src)
    const wide = constrainCam({ x: 0.1, y: 0.4, w: 0.8, h: 0.1 }, src)
    const { min, max } = camAspectRange()
    expect(rectAspect(tall, src)).toBeCloseTo(min, 6)
    expect(rectAspect(wide, src)).toBeCloseTo(max, 6)
  })
  it('gives the game the rest of the vertical frame', () => {
    const cam = { x: 0.7, y: 0.6, w: 0.28, h: 0.36 }
    const aspect = gameSlotAspect(cam, src)
    const g = verticalGeometry({ ...camGame, cam }, src)
    expect(aspect).toBeCloseTo(1080 / g.gameHeight, 6)
    expect(gameSlotAspect(null, src)).toBeCloseTo(9 / 16, 6)
  })
})

describe('normalizeLayout', () => {
  it('opens an old cam layout (game = whole frame) as the crop the export already made', () => {
    const n = normalizeLayout(camGame, src)
    const exported = verticalGeometry(camGame, src)
    const shown = toPixels(n.game, src)
    expect(Math.abs(shown.x - exported.game.x)).toBeLessThanOrEqual(4)
    expect(Math.abs(shown.y - exported.game.y)).toBeLessThanOrEqual(4)
    expect(Math.abs(shown.w - exported.game.w)).toBeLessThanOrEqual(4)
    expect(Math.abs(shown.h - exported.game.h)).toBeLessThanOrEqual(4)
    expect(n.cam).toEqual(camGame.cam)
  })
  it('is idempotent', () => {
    const once = normalizeLayout(camGame, src)
    const twice = normalizeLayout(once, src)
    for (const k of ['x', 'y', 'w', 'h'] as const) expect(twice.game[k]).toBeCloseTo(once.game[k], 6)
  })
  it('snaps a centre crop to 9:16 and drops a stray cam', () => {
    const n = normalizeLayout({ ...camGame, kind: 'center_crop' }, src)
    expect(n.cam).toBeNull()
    expect(rectAspect(n.game, src)).toBeCloseTo(9 / 16, 6)
  })
  it('keeps a full-frame layout as drawn but clamped', () => {
    const n = normalizeLayout({ id: 'l2', name: 'Full', kind: 'blur_fill', cam: camGame.cam, game: { x: 0.5, y: 0.5, w: 0.8, h: 0.8 } }, src)
    expect(n.cam).toBeNull()
    expect(inFrame(n.game)).toBe(true)
  })
  it('treats a cam layout without a cam as a centre crop', () => {
    const n = normalizeLayout({ ...camGame, cam: null }, src)
    expect(rectAspect(n.game, src)).toBeCloseTo(9 / 16, 6)
  })
})

describe('dragRect', () => {
  const r0: Rect = { x: 0.3, y: 0.3, w: 0.2, h: 0.2 }

  it('moves and stops at the frame edges', () => {
    expect(dragRect(r0, 'move', 0.1, -0.1, src)).toMatchObject({ x: 0.4, y: 0.2, w: 0.2, h: 0.2 })
    const far = dragRect(r0, 'move', 5, 5, src)
    expect(far.x).toBeCloseTo(0.8, 6)
    expect(far.y).toBeCloseTo(0.8, 6)
    const back = dragRect(r0, 'move', -5, -5, src)
    expect(back.x).toBeCloseTo(0, 6)
    expect(back.y).toBeCloseTo(0, 6)
  })

  it('resizes freely from every handle, anchoring the opposite side', () => {
    const se = dragRect(r0, 'se', 0.1, 0.05, src)
    expect(se).toMatchObject({ x: 0.3, y: 0.3 })
    expect(se.w).toBeCloseTo(0.3, 6)
    expect(se.h).toBeCloseTo(0.25, 6)
    const nw = dragRect(r0, 'nw', -0.1, -0.05, src)
    expect(nw.x + nw.w).toBeCloseTo(0.5, 6)
    expect(nw.y + nw.h).toBeCloseTo(0.5, 6)
    expect(nw.w).toBeCloseTo(0.3, 6)
    const e = dragRect(r0, 'e', 0.1, 0.3, src)
    expect(e.x).toBeCloseTo(0.3, 6)
    expect(e.w).toBeCloseTo(0.3, 6)
    expect(e.h).toBeCloseTo(0.2, 6)
    const n = dragRect(r0, 'n', 0.3, -0.1, src)
    expect(n.y).toBeCloseTo(0.2, 6)
    expect(n.h).toBeCloseTo(0.3, 6)
    expect(n.w).toBeCloseTo(0.2, 6)
  })

  it('never inverts or shrinks below the minimum, and stays in the frame', () => {
    const tiny = dragRect(r0, 'se', -1, -1, src)
    expect(tiny.w).toBeCloseTo(MIN_RECT, 6)
    expect(tiny.h).toBeCloseTo(MIN_RECT, 6)
    const flipped = dragRect(r0, 'w', 1, 0, src)
    expect(flipped.w).toBeCloseTo(MIN_RECT, 6)
    expect(flipped.x + flipped.w).toBeCloseTo(0.5, 6)
    const big = dragRect(r0, 'se', 5, 5, src)
    expect(inFrame(big)).toBe(true)
    expect(big.x + big.w).toBeCloseTo(1, 6)
  })

  it('holds the aspect on corner drags, scaling from the opposite corner', () => {
    const aspect = 9 / 16
    const start = fitRectAspect({ x: 0.3, y: 0.1, w: 0.4, h: 0.8 }, aspect, src)
    for (const handle of ['nw', 'ne', 'sw', 'se'] as const) {
      for (const [dx, dy] of [[0.05, 0.02], [-0.08, 0.1], [0.2, -0.3]] as const) {
        const r = dragRect(start, handle, dx, dy, src, { aspect })
        expect(rectAspect(r, src)).toBeCloseTo(aspect, 6)
        expect(inFrame(r)).toBe(true)
      }
    }
    const grown = dragRect(start, 'se', 0.03, 0.03, src, { aspect })
    expect(grown.x).toBeCloseTo(start.x, 6)
    expect(grown.y).toBeCloseTo(start.y, 6)
    expect(grown.w).toBeGreaterThan(start.w)
    const nw = dragRect(start, 'nw', -0.02, -0.02, src, { aspect })
    expect(nw.x + nw.w).toBeCloseTo(start.x + start.w, 6)
    expect(nw.y + nw.h).toBeCloseTo(start.y + start.h, 6)
  })

  it('holds the aspect on edge drags, growing the other axis around the centre', () => {
    const aspect = 2
    const start: Rect = { x: 0.4, y: 0.4, w: 0.2, h: 0.2 * (16 / 9) / 2 }
    const e = dragRect(start, 'e', 0.1, 0, src, { aspect })
    expect(rectAspect(e, src)).toBeCloseTo(aspect, 6)
    expect(e.x).toBeCloseTo(start.x, 6)
    expect(e.y + e.h / 2).toBeCloseTo(start.y + start.h / 2, 6)
    const s = dragRect(start, 's', 0, 0.1, src, { aspect })
    expect(rectAspect(s, src)).toBeCloseTo(aspect, 6)
    expect(s.y).toBeCloseTo(start.y, 6)
    expect(s.x + s.w / 2).toBeCloseTo(start.x + start.w / 2, 6)
    const w = dragRect(start, 'w', -0.1, 0, src, { aspect })
    expect(w.x + w.w).toBeCloseTo(start.x + start.w, 6)
    const n = dragRect(start, 'n', 0, -0.1, src, { aspect })
    expect(n.y + n.h).toBeCloseTo(start.y + start.h, 6)
  })

  it('stops a locked resize at the frame edge and at the minimum', () => {
    const aspect = 1.5
    const start: Rect = { x: 0.6, y: 0.5, w: 0.2, h: (0.2 * 1920) / 1.5 / 1080 }
    const big = dragRect(start, 'se', 3, 3, src, { aspect })
    expect(inFrame(big)).toBe(true)
    expect(rectAspect(big, src)).toBeCloseTo(aspect, 6)
    const wide = dragRect(start, 'e', 3, 0, src, { aspect })
    expect(inFrame(wide)).toBe(true)
    expect(rectAspect(wide, src)).toBeCloseTo(aspect, 6)
    const small = dragRect(start, 'se', -3, -3, src, { aspect })
    expect(small.w * src.width).toBeGreaterThanOrEqual(MIN_RECT * src.width - 1e-6)
    expect(small.h * src.height).toBeGreaterThanOrEqual(MIN_RECT * src.height - 1e-6)
    expect(rectAspect(small, src)).toBeCloseTo(aspect, 6)
  })

  it('keeps a free resize inside an aspect range by holding back the dragged edge', () => {
    const { min, max } = camAspectRange()
    const start: Rect = { x: 0.3, y: 0.3, w: 0.2, h: (0.2 * 1920) / 1.5 / 1080 }
    const wide = dragRect(start, 'e', 0.5, 0, src, { aspectRange: { min, max } })
    expect(rectAspect(wide, src)).toBeCloseTo(max, 6)
    expect(wide.x).toBeCloseTo(start.x, 6)
    const tall = dragRect(start, 's', 0, 0.5, src, { aspectRange: { min, max } })
    expect(rectAspect(tall, src)).toBeCloseTo(min, 6)
    expect(tall.y).toBeCloseTo(start.y, 6)
    const cornerTall = dragRect(start, 'nw', 0, -0.4, src, { aspectRange: { min, max } })
    expect(rectAspect(cornerTall, src)).toBeCloseTo(min, 6)
    expect(cornerTall.y + cornerTall.h).toBeCloseTo(start.y + start.h, 6)
    // In range it is untouched.
    const ok = dragRect(start, 'e', 0.02, 0, src, { aspectRange: { min, max } })
    expect(ok.w).toBeCloseTo(start.w + 0.02, 6)
  })
})

describe('dragLayout', () => {
  const start = normalizeLayout(camGame, src)

  it('keeps the game area locked to the slot below the cam while it is dragged', () => {
    const next = dragLayout(start, 'game', 'se', -0.05, -0.05, src)
    expect(rectAspect(next.game, src)).toBeCloseTo(gameSlotAspect(start.cam, src), 6)
    expect(next.cam).toEqual(start.cam)
    const moved = dragLayout(start, 'game', 'move', 0.01, 0, src)
    expect(moved.game.w).toBeCloseTo(start.game.w, 6)
  })

  it('re-locks the game area when the cam changes shape', () => {
    const next = dragLayout(start, 'cam', 'n', 0, -0.2, src)
    expect(next.cam!.h).toBeGreaterThan(start.cam!.h)
    expect(rectAspect(next.game, src)).toBeCloseTo(gameSlotAspect(next.cam, src), 6)
    expect(inFrame(next.game)).toBe(true)
  })

  it('never lets the cam leave the aspects it can be shown at', () => {
    const { min, max } = camAspectRange()
    for (const [dx, dy] of [[0.5, 0], [-0.7, 0], [0, 0.6], [0, -0.6]] as const) {
      for (const handle of ['e', 'w', 'n', 's', 'nw', 'se'] as const) {
        const a = rectAspect(dragLayout(start, 'cam', handle, dx, dy, src).cam!, src)
        expect(a).toBeGreaterThanOrEqual(min - 1e-6)
        expect(a).toBeLessThanOrEqual(max + 1e-6)
      }
    }
  })

  it('leaves a full-frame layout free-form', () => {
    const blur: Layout = { id: 'l2', name: 'Full', kind: 'blur_fill', cam: null, game: { x: 0.1, y: 0.1, w: 0.5, h: 0.5 } }
    const next = dragLayout(blur, 'game', 'e', 0.2, 0, src)
    expect(next.game.w).toBeCloseTo(0.7, 6)
    expect(next.game.h).toBeCloseTo(0.5, 6)
  })
})

describe('layouts as values', () => {
  it('makes new layouts already snapped to their slots', () => {
    const cam = newLayout('new-layout-1', 'Cam', 'cam_game', src)
    expect(cam.cam).not.toBeNull()
    expect(rectAspect(cam.game, src)).toBeCloseTo(gameSlotAspect(cam.cam, src), 6)
    const blur = newLayout('new-layout-2', 'Full', 'blur_fill', src)
    expect(blur.cam).toBeNull()
    expect(blur.game).toEqual(FULL)
  })

  it('switches kinds, adding or dropping the cam', () => {
    const blur = withKind(camGame, 'blur_fill', src)
    expect(blur.cam).toBeNull()
    const back = withKind(blur, 'cam_game', src)
    expect(back.cam).not.toBeNull()
    expect(withKind(camGame, 'center_crop', src).cam).toBeNull()
  })

  it('duplicates with a fresh id and an unused "copy" name, without sharing rects', () => {
    const copy = duplicateLayout(camGame, 'copy-layout-1', ['Cam'])
    expect(copy).toMatchObject({ id: 'copy-layout-1', name: 'Cam copy', kind: 'cam_game' })
    expect(copy.cam).toEqual(camGame.cam)
    expect(copy.cam).not.toBe(camGame.cam)
    expect(duplicateLayout(camGame, 'copy-layout-2', ['Cam', 'Cam copy']).name).toBe('Cam copy 2')
    expect(duplicateLayout({ ...camGame, name: 'Cam copy' }, 'copy-layout-3', ['Cam copy']).name).toBe('Cam copy 2')
    expect(duplicateLayout({ ...camGame, name: 'x'.repeat(40) }, 'copy-layout-4', []).name.length).toBeLessThanOrEqual(40)
  })
})

describe('layoutPlan', () => {
  it('stacks cam over game for a vertical cam layout, matching verticalGeometry', () => {
    const plan = layoutPlan(camGame, 'vertical', src)
    const g = verticalGeometry(camGame, src)
    expect(plan).toEqual({ mode: 'stack', cam: g.cam, camHeight: g.camHeight, game: g.game, gameHeight: g.gameHeight })
  })
  it('crops a centre crop or a cam layout without a cam to 9:16', () => {
    const plan = layoutPlan({ ...camGame, kind: 'center_crop', cam: null }, 'vertical', src)
    expect(plan.mode).toBe('crop')
    if (plan.mode === 'crop') expect(plan.src.w / plan.src.h).toBeCloseTo(9 / 16, 2)
    expect(layoutPlan({ ...camGame, cam: null }, 'vertical', src).mode).toBe('crop')
  })
  it('blurs the game area for a full-frame layout', () => {
    const blur: Layout = { id: 'l2', name: 'Full', kind: 'blur_fill', cam: null, game: { x: 0.25, y: 0, w: 0.5, h: 1 } }
    expect(layoutPlan(blur, 'vertical', src)).toEqual({ mode: 'blur', src: toPixels(blur.game, src) })
  })
  it('crops a horizontal export to 16:9: the game area for a full-frame layout, the whole frame otherwise', () => {
    const blur: Layout = { id: 'l2', name: 'Full', kind: 'blur_fill', cam: null, game: { x: 0.1, y: 0.1, w: 0.5, h: 0.6 } }
    const b = layoutPlan(blur, 'horizontal', src)
    expect(b.mode).toBe('crop')
    if (b.mode === 'crop') {
      expect(b.src.w / b.src.h).toBeCloseTo(16 / 9, 1)
      expect(b.src.x).toBeGreaterThanOrEqual(toPixels(blur.game, src).x)
      expect(b.src.x + b.src.w).toBeLessThanOrEqual(toPixels(blur.game, src).x + toPixels(blur.game, src).w)
    }
    const narrow = normalizeLayout(camGame, src)
    expect(layoutPlan(narrow, 'horizontal', src)).toEqual({ mode: 'crop', src: { x: 0, y: 0, w: 1920, h: 1080 } })
  })
  it('gives every plan even, in-frame pixels', () => {
    for (const layout of [camGame, normalizeLayout(camGame, src), { ...camGame, kind: 'blur_fill' as const, cam: null }]) {
      for (const format of ['vertical', 'horizontal'] as const) {
        const plan = layoutPlan(layout, format, src)
        const rects = plan.mode === 'stack' ? [plan.cam, plan.game] : [plan.src]
        for (const r of rects) {
          expect([r.x, r.y, r.w, r.h].every((n) => n % 2 === 0)).toBe(true)
          expect(r.x + r.w).toBeLessThanOrEqual(src.width)
          expect(r.y + r.h).toBeLessThanOrEqual(src.height)
        }
      }
    }
  })
  it('shows exactly what the editor drew for a normalised cam layout', () => {
    const n = normalizeLayout(camGame, src)
    const plan = layoutPlan(n, 'vertical', src)
    if (plan.mode !== 'stack') throw new Error('expected a stack')
    const camBox = toPixels(n.cam!, src)
    const gameBox = toPixels(n.game, src)
    // No further trimming beyond even-pixel rounding.
    expect(Math.abs(plan.cam.w - camBox.w)).toBeLessThanOrEqual(4)
    expect(Math.abs(plan.cam.h - camBox.h)).toBeLessThanOrEqual(4)
    expect(Math.abs(plan.game.w - gameBox.w)).toBeLessThanOrEqual(4)
    expect(Math.abs(plan.game.h - gameBox.h)).toBeLessThanOrEqual(4)
  })
})

describe('stackHeights', () => {
  it('passes the full-size height through and scales a smaller output, kept even', () => {
    expect(stackHeights(600, { width: 1080, height: 1920 })).toEqual({ camHeight: 600, gameHeight: 1320 })
    const small = stackHeights(600, { width: 360, height: 640 })
    expect(small.camHeight % 2).toBe(0)
    expect(small.camHeight + small.gameHeight).toBe(640)
    expect(small.camHeight).toBe(200)
  })
})
