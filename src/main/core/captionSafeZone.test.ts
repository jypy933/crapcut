import { describe, expect, it } from 'vitest'
import { defaultCaptionY } from '@shared/captionPlacement'
import { CAPTION_STYLES } from '@shared/captionStyles'
import type { Word } from '@shared/types'
import { buildAss, defaultAssStyle } from './ass'
import { blockOverflow, captionFontSize, captionOutline, estimateCaptionBlock, fitCaptionStyle, HORIZONTAL_ZONE, SAFE_ZONES, safeZone, textWidthPx, wrapLines } from '@shared/captionSafeZone'
import { checkCaptionsInZone } from './exportChecks'

const words = (text: string): Word[] => text.split(' ').map((t, i) => ({ t0: i * 0.3, t1: i * 0.3 + 0.25, text: t }))
const style = (y: number, format: 'vertical' | 'horizontal' = 'vertical') => defaultAssStyle(format, y, true, CAPTION_STYLES[0])

describe('caption sizes', () => {
  it('match what the ASS style uses', () => {
    for (const format of ['vertical', 'horizontal'] as const) {
      const s = defaultAssStyle(format, 0.5, true, CAPTION_STYLES[1])
      expect(s.fontSize).toBe(captionFontSize(format))
      expect(s.outline).toBe(captionOutline(format, CAPTION_STYLES[1]!))
    }
  })
})

describe('caption block estimate', () => {
  it('wraps greedily and keeps an over-long word on its own line', () => {
    expect(wrapLines('AA BB CC', 88, 1000)).toEqual(['AA BB CC'])
    expect(wrapLines('AAAAAAAAAA BBBBBBBBBB', 88, textWidthPx('AAAAAAAAAA', 88) + 10)).toEqual(['AAAAAAAAAA', 'BBBBBBBBBB'])
    expect(wrapLines('SUPERCALIFRAGILISTICEXPIALIDOCIOUS X', 88, 200)).toHaveLength(2)
  })

  it('grows taller with more lines and a bigger font', () => {
    const base = { texts: ['HI THERE'], fontSize: 88, outline: 7, scale: 1, frameWidth: 1080, marginX: 65 }
    const one = estimateCaptionBlock(base)
    expect(one.lines).toBe(1)
    expect(estimateCaptionBlock({ ...base, texts: ['A LONG LINE THAT NEEDS TWO ROWS'] }).height).toBeGreaterThan(one.height * 1.8)
    expect(estimateCaptionBlock({ ...base, fontSize: 120 }).height).toBeGreaterThan(one.height)
  })

  it('reports how far a block spills past each edge', () => {
    const block = { height: 200, widest: 600, lines: 1 }
    expect(blockOverflow(block, 1200, 1080, SAFE_ZONES.reels)).toEqual({ left: 0, right: 0, top: 0, bottom: 50 })
    expect(blockOverflow(block, 300, 1080, SAFE_ZONES.reels)).toMatchObject({ top: 85, bottom: 0 })
    expect(blockOverflow({ ...block, widest: 1000 }, 800, 1080, SAFE_ZONES.tiktok)).toMatchObject({ left: 40, right: 80 })
  })
})

describe('fitCaptionStyle', () => {
  const w = words('this is a fairly long caption line for testing')

  it('leaves a style that already fits alone', () => {
    const s = style(0.5)
    const fit = fitCaptionStyle(words('hi there'), s, SAFE_ZONES.tiktok)
    expect(fit.adjusted).toBe(false)
    expect(fit.style).toBe(s)
  })

  it('leaves a clip without captions alone', () => {
    expect(fitCaptionStyle([], style(0.9), SAFE_ZONES.reels).adjusted).toBe(false)
  })

  it('pushes captions dragged low up until the estimate clears each platform', () => {
    for (const zone of Object.values(SAFE_ZONES)) {
      const fit = fitCaptionStyle(w, style(0.9), zone)
      expect(fit.adjusted).toBe(true)
      expect(fit.before.bottom).toBeGreaterThan(0)
      expect(fit.style.y).toBeLessThan(0.9)
      expect(checkCaptionsInZone(buildAss(w, fit.style), zone).ok).toBe(true)
    }
  })

  it('pushes captions dragged high down below the top margin', () => {
    const fit = fitCaptionStyle(w, style(0.09), SAFE_ZONES.reels)
    expect(fit.adjusted).toBe(true)
    expect(fit.style.y * 1920).toBeGreaterThan(SAFE_ZONES.reels.top)
    expect(checkCaptionsInZone(buildAss(w, fit.style), SAFE_ZONES.reels).ok).toBe(true)
  })

  it('narrows the wrap when a wide line would reach past the nearer side of the zone', () => {
    const wide = words('gaming moments')
    const fit = fitCaptionStyle(wide, style(0.5), SAFE_ZONES.tiktok)
    expect(fit.before.left + fit.before.right).toBeGreaterThan(0)
    expect(fit.style.marginX).toBeGreaterThanOrEqual(120)
    expect(checkCaptionsInZone(buildAss(wide, fit.style), SAFE_ZONES.tiktok).ok).toBe(true)
  })

  it('moves the default placement a little for TikTok and more for Reels', () => {
    const y = defaultCaptionY('vertical')
    const tiktok = fitCaptionStyle(w, style(y), SAFE_ZONES.tiktok).style.y
    const reels = fitCaptionStyle(w, style(y), SAFE_ZONES.reels).style.y
    expect(tiktok).toBeLessThanOrEqual(y)
    expect(reels).toBeLessThan(tiktok)
  })

  it('uses the title-safe margin for 16:9 and the platform zone for 9:16', () => {
    expect(safeZone('horizontal')).toBe(HORIZONTAL_ZONE)
    expect(safeZone('vertical')).toBe(SAFE_ZONES.tiktok)
    expect(safeZone('vertical', 'reels')).toBe(SAFE_ZONES.reels)
    expect(fitCaptionStyle(w, style(0.97, 'horizontal'), HORIZONTAL_ZONE).style.y * 1080).toBeLessThan(HORIZONTAL_ZONE.bottom)
  })
})
