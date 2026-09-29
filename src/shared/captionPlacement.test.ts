import { describe, expect, it } from 'vitest'
import {
  CAPTION_DEFAULT_Y,
  CAPTION_Y_MAX,
  CAPTION_Y_MIN,
  captionMoved,
  captionY,
  clampCaptionY,
  defaultCaptionY,
  placeCaptionY,
  resetCaptionY,
  withCaptionY
} from './captionPlacement'
import { OUTPUT_SIZE, type RenderFormat } from './layoutGeometry'
import { safeArea, toOutputPixels } from './overlayPosition'
import type { CaptionSettings } from './types'

const base: CaptionSettings = { enabled: true, y: CAPTION_DEFAULT_Y, uppercase: true, styleId: 'clean' }

describe('captionY', () => {
  it('uses the saved height in 9:16', () => {
    expect(captionY({ y: 0.4 }, 'vertical')).toBe(0.4)
  })
  it('derives the 16:9 height for a clip saved before 16:9 had its own (unchanged export)', () => {
    expect(captionY({ y: 0.72 }, 'horizontal')).toBeCloseTo(0.82)
    expect(captionY({ y: 0.3 }, 'horizontal')).toBe(0.6)
    expect(captionY({ y: 0.92 }, 'horizontal')).toBe(0.92)
  })
  it('uses the 16:9 height when he set one', () => {
    expect(captionY({ y: 0.72, yHorizontal: 0.4 }, 'horizontal')).toBe(0.4)
    expect(captionY({ y: 0.72, yHorizontal: 0.4 }, 'vertical')).toBe(0.72)
  })
  it('clamps a stray saved value into the draggable range', () => {
    expect(captionY({ y: 0 }, 'vertical')).toBe(CAPTION_Y_MIN)
    expect(captionY({ y: 1 }, 'vertical')).toBe(CAPTION_Y_MAX)
    expect(captionY({ y: 0.5, yHorizontal: 5 }, 'horizontal')).toBe(CAPTION_Y_MAX)
  })
})

describe('defaults', () => {
  it('has a 9:16 default clear of the apps at the bottom', () => {
    expect(defaultCaptionY('vertical')).toBe(CAPTION_DEFAULT_Y)
    expect(CAPTION_DEFAULT_Y).toBeLessThan(safeArea('vertical').bottom)
  })
  it('does not depend on the 9:16 height in 9:16', () => {
    expect(defaultCaptionY('vertical', 0.3)).toBe(CAPTION_DEFAULT_Y)
  })
  it('reports whether the captions were moved', () => {
    expect(captionMoved(base, 'vertical')).toBe(false)
    expect(captionMoved({ ...base, y: 0.5 }, 'vertical')).toBe(true)
    expect(captionMoved(base, 'horizontal')).toBe(false)
    expect(captionMoved({ ...base, yHorizontal: 0.5 }, 'horizontal')).toBe(true)
  })
})

describe('withCaptionY / resetCaptionY', () => {
  it('saves a 9:16 move in y, rounded, and leaves 16:9 alone', () => {
    const next = withCaptionY({ ...base, yHorizontal: 0.7 }, 'vertical', 0.456789)
    expect(next.y).toBe(0.4568)
    expect(next.yHorizontal).toBe(0.7)
  })
  it('saves a 16:9 move in yHorizontal and leaves 9:16 alone', () => {
    const next = withCaptionY(base, 'horizontal', 0.6)
    expect(next.yHorizontal).toBe(0.6)
    expect(next.y).toBe(CAPTION_DEFAULT_Y)
  })
  it('clamps what it saves', () => {
    expect(withCaptionY(base, 'vertical', 2).y).toBe(CAPTION_Y_MAX)
    expect(withCaptionY(base, 'horizontal', -1).yHorizontal).toBe(CAPTION_Y_MIN)
  })
  it('drops the 16:9 override when it is put back on the default', () => {
    const moved = withCaptionY(base, 'horizontal', 0.5)
    const back = withCaptionY(moved, 'horizontal', defaultCaptionY('horizontal', base.y))
    expect('yHorizontal' in back).toBe(false)
  })
  it('resets one format to its default', () => {
    expect(resetCaptionY({ ...base, y: 0.4 }, 'vertical').y).toBe(CAPTION_DEFAULT_Y)
    const noOverride = resetCaptionY({ ...base, yHorizontal: 0.3 }, 'horizontal')
    expect('yHorizontal' in noOverride).toBe(false)
    expect(captionY(noOverride, 'horizontal')).toBeCloseTo(0.82)
  })
})

describe('placeCaptionY', () => {
  it('follows the pointer when nothing is near', () => {
    expect(placeCaptionY(0.6, 'vertical')).toEqual({ y: 0.6, guide: null })
    expect(placeCaptionY(0.3, 'vertical')).toEqual({ y: 0.3, guide: null })
  })
  it('snaps back onto the default height', () => {
    expect(placeCaptionY(CAPTION_DEFAULT_Y + 0.01, 'vertical')).toEqual({ y: CAPTION_DEFAULT_Y, guide: CAPTION_DEFAULT_Y })
    expect(placeCaptionY(0.83, 'horizontal', { verticalY: 0.72 }).y).toBeCloseTo(0.82)
  })
  it('snaps to the middle of the frame', () => {
    expect(placeCaptionY(0.51, 'vertical')).toEqual({ y: 0.5, guide: 0.5 })
  })
  it('snaps the block against the top and bottom edges of the 9:16 safe area', () => {
    const area = safeArea('vertical')
    const top = placeCaptionY(0.16, 'vertical')
    expect(top.guide).toBe(area.top)
    expect(top.y).toBeGreaterThan(area.top)
    const bottom = placeCaptionY(0.75, 'vertical')
    expect(bottom.guide).toBe(area.bottom)
    expect(bottom.y).toBeLessThan(area.bottom)
  })
  it('limits the drag to the range', () => {
    expect(placeCaptionY(-3, 'vertical', { snap: false }).y).toBe(CAPTION_Y_MIN)
    expect(placeCaptionY(3, 'vertical').y).toBeLessThanOrEqual(CAPTION_Y_MAX)
    expect(placeCaptionY(3, 'horizontal').y).toBeLessThanOrEqual(CAPTION_Y_MAX)
  })
  it('moves freely when snapping is off', () => {
    expect(placeCaptionY(0.51, 'vertical', { snap: false })).toEqual({ y: 0.51, guide: null })
    expect(placeCaptionY(CAPTION_DEFAULT_Y + 0.005, 'vertical', { snap: false }).y).toBeCloseTo(CAPTION_DEFAULT_Y + 0.005)
  })
  it('never lands outside the range even after snapping', () => {
    for (const format of ['vertical', 'horizontal'] as const) {
      for (let y = -0.2; y <= 1.2; y += 0.013) {
        const p = placeCaptionY(y, format)
        expect(p.y).toBeGreaterThanOrEqual(CAPTION_Y_MIN)
        expect(p.y).toBeLessThanOrEqual(CAPTION_Y_MAX)
        expect(clampCaptionY(p.y)).toBe(p.y)
      }
    }
  })
})

describe('preview and ASS use one mapping', () => {
  it('turns the saved height into the pixel the ASS \\pos uses, in both formats', () => {
    const cases: { format: RenderFormat; captions: Pick<CaptionSettings, 'y' | 'yHorizontal'>; pixel: number }[] = [
      { format: 'vertical', captions: { y: 0.72 }, pixel: 1382 },
      { format: 'vertical', captions: { y: 0.5 }, pixel: 960 },
      { format: 'horizontal', captions: { y: 0.72 }, pixel: 886 },
      { format: 'horizontal', captions: { y: 0.72, yHorizontal: 0.5 }, pixel: 540 }
    ]
    for (const c of cases) {
      const px = toOutputPixels({ x: 0.5, y: captionY(c.captions, c.format) }, OUTPUT_SIZE[c.format])
      expect(px).toEqual({ x: OUTPUT_SIZE[c.format].width / 2, y: c.pixel })
    }
  })
})
