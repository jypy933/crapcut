import { describe, expect, it } from 'vitest'
import { boxSnapTargets, clampBoxPos, pointerToNorm, roundNorm, safeArea, snapAxis, toOutputPixels, toPercent } from './overlayPosition'

describe('clampBoxPos', () => {
  it('keeps the whole box inside the frame', () => {
    expect(clampBoxPos({ x: -0.2, y: 1.4 }, { w: 0.5, h: 0.3 })).toEqual({ x: 0, y: 0.7 })
    expect(clampBoxPos({ x: 0.9, y: -1 }, { w: 0.5, h: 0.3 })).toEqual({ x: 0.5, y: 0 })
  })
  it('leaves a position that fits alone', () => {
    expect(clampBoxPos({ x: 0.2, y: 0.3 }, { w: 0.5, h: 0.3 })).toEqual({ x: 0.2, y: 0.3 })
  })
  it('pins a box as big as the frame to the corner', () => {
    expect(clampBoxPos({ x: 0.4, y: 0.4 }, { w: 1, h: 1.2 })).toEqual({ x: 0, y: 0 })
  })
})

describe('toOutputPixels / toPercent / pointerToNorm', () => {
  it('rounds to whole output pixels for both formats', () => {
    expect(toOutputPixels({ x: 0.5, y: 0.72 }, { width: 1080, height: 1920 })).toEqual({ x: 540, y: 1382 })
    expect(toOutputPixels({ x: 0.5, y: 0.82 }, { width: 1920, height: 1080 })).toEqual({ x: 960, y: 886 })
  })
  it('gives the same place as a preview percentage', () => {
    expect(toPercent({ x: 0.25, y: 0.5 })).toEqual({ left: '25%', top: '50%' })
  })
  it('turns a pointer over the frame into fractions of it', () => {
    const frame = { left: 100, top: 50, width: 200, height: 400 }
    expect(pointerToNorm(200, 250, frame)).toEqual({ x: 0.5, y: 0.5 })
    expect(pointerToNorm(100, 50, frame)).toEqual({ x: 0, y: 0 })
    // Outside the frame is not clamped here; callers clamp to what they place.
    expect(pointerToNorm(0, 850, frame).y).toBe(2)
  })
  it('rounds for saving', () => {
    expect(roundNorm(0.123456)).toBe(0.1235)
  })
})

describe('snapAxis', () => {
  const targets = [
    { at: 0.5, guide: 0.5 },
    { at: 0.8, guide: 0.78 }
  ]
  it('snaps to the nearest target within the distance', () => {
    expect(snapAxis(0.51, targets)).toEqual({ value: 0.5, guide: 0.5 })
    expect(snapAxis(0.79, targets)).toEqual({ value: 0.8, guide: 0.78 })
  })
  it('leaves the value alone when nothing is close', () => {
    expect(snapAxis(0.65, targets)).toEqual({ value: 0.65, guide: null })
  })
  it('picks the closer target when two are in range', () => {
    const close = [
      { at: 0.5, guide: 0.5 },
      { at: 0.52, guide: 0.52 }
    ]
    expect(snapAxis(0.516, close).value).toBe(0.52)
  })
  it('does nothing without targets', () => {
    expect(snapAxis(0.3, [])).toEqual({ value: 0.3, guide: null })
  })
})

describe('boxSnapTargets', () => {
  it('lines up the start and the end edge with each line, and the centre with the middle', () => {
    const t = boxSnapTargets(0.2, [0.1, 0.8])
    expect(t).toContainEqual({ at: 0.1, guide: 0.1 })
    expect(t).toContainEqual({ at: 0.1 - 0.2, guide: 0.1 })
    expect(t).toContainEqual({ at: 0.8 - 0.2, guide: 0.8 })
    expect(t).toContainEqual({ at: 0.4, guide: 0.5 })
  })
  it('can leave out the centre', () => {
    expect(boxSnapTargets(0.2, [0.1], false)).toHaveLength(2)
  })
})

describe('safeArea', () => {
  it('keeps clear of the short-video apps in 9:16', () => {
    const a = safeArea('vertical')
    expect(a.top).toBeGreaterThan(0.05)
    expect(a.bottom).toBeLessThan(0.85)
    expect(a.right).toBeLessThan(0.95)
    expect(a.covered.length).toBe(3)
  })
  it('is only a thin margin in 16:9', () => {
    const a = safeArea('horizontal')
    expect(a.top).toBeCloseTo(0.05)
    expect(a.bottom).toBeCloseTo(0.95)
  })
  it('describes covered rectangles that stay inside the frame', () => {
    for (const format of ['vertical', 'horizontal'] as const) {
      for (const r of safeArea(format).covered) {
        expect(r.x).toBeGreaterThanOrEqual(0)
        expect(r.y).toBeGreaterThanOrEqual(0)
        expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9)
        expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9)
      }
    }
  })
})
