import { describe, expect, it } from 'vitest'
import type { Word } from '@shared/types'
import { buildAss, defaultAssStyle } from './ass'
import { SAFE_ZONES } from '@shared/captionSafeZone'
import {
  barsFromCrops,
  captionLayoutFromAss,
  checkAudio,
  checkBars,
  checkCaptionsInZone,
  checkNoWatermark,
  checkResolution,
  cropSampleTimes,
  evaluateExport,
  parseCropdetect,
  parseVolumeDetect,
  type ExportExpectations,
  type ExportMeasurements,
  type VideoMeasure
} from './exportChecks'

const video = (over: Partial<VideoMeasure> = {}): VideoMeasure => ({ width: 1080, height: 1920, hasVideo: true, hasAudio: true, durationSec: 20, ...over })
const full = { x: 0, y: 0, w: 1080, h: 1920 }
const words: Word[] = [
  { t0: 0, t1: 0.4, text: 'hello' },
  { t0: 0.4, t1: 0.8, text: 'there' }
]
const ass = (y = 0.5): string => buildAss(words, defaultAssStyle('vertical', y, true))

describe('parsing', () => {
  it('reads volumedetect', () => {
    expect(parseVolumeDetect('[Parsed_volumedetect_0] mean_volume: -21.3 dB\n[Parsed_volumedetect_0] max_volume: -1.5 dB')).toEqual({ meanDb: -21.3, maxDb: -1.5 })
    expect(parseVolumeDetect('mean_volume: -91.0 dB\nmax_volume: -91.0 dB')).toEqual({ meanDb: -91, maxDb: -91 })
    expect(parseVolumeDetect('nothing here')).toBeNull()
  })

  it('takes the last usable cropdetect line and ignores empty ones', () => {
    expect(parseCropdetect('crop=1080:1800:0:60\nfoo\ncrop=1080:1792:0:64\n')).toEqual({ x: 0, y: 64, w: 1080, h: 1792 })
    expect(parseCropdetect('crop=-1:-1:0:0')).toBeNull()
    expect(parseCropdetect('no crop')).toBeNull()
  })

  it('samples inside the clip', () => {
    expect(cropSampleTimes(20)).toEqual([4, 10, 16])
    expect(cropSampleTimes(0.2).every((x) => x === 0)).toBe(true)
  })
})

describe('resolution', () => {
  it('passes the exact output size and fails anything else', () => {
    expect(checkResolution(video(), 'vertical').ok).toBe(true)
    expect(checkResolution(video({ width: 1920, height: 1080 }), 'horizontal').ok).toBe(true)
    expect(checkResolution(video({ width: 720, height: 1280 }), 'vertical')).toMatchObject({ ok: false, severity: 'broken' })
    expect(checkResolution(video({ width: 1920, height: 1080 }), 'vertical').ok).toBe(false)
    expect(checkResolution(video({ hasVideo: false, width: 0, height: 0 }), 'vertical').severity).toBe('broken')
  })
})

describe('audio', () => {
  const loud = { meanDb: -20, maxDb: -1.5 }
  const silent = { meanDb: -91, maxDb: -91 }
  it('passes real sound', () => {
    expect(checkAudio(video(), loud, { sourceHadAudio: true, sourceSilent: false }).ok).toBe(true)
  })
  it('is broken when the source had sound but the export has none or only silence', () => {
    expect(checkAudio(video({ hasAudio: false }), null, { sourceHadAudio: true, sourceSilent: null })).toMatchObject({ ok: false, severity: 'broken' })
    expect(checkAudio(video(), silent, { sourceHadAudio: true, sourceSilent: false })).toMatchObject({ ok: false, severity: 'broken' })
  })
  it('only warns when the source itself was silent (a muted stretch) or had no audio', () => {
    expect(checkAudio(video(), silent, { sourceHadAudio: true, sourceSilent: true })).toMatchObject({ ok: false, severity: 'warn' })
    expect(checkAudio(video({ hasAudio: false }), null, { sourceHadAudio: false, sourceSilent: null })).toMatchObject({ ok: false, severity: 'warn' })
  })
  it('does not judge a level it could not measure', () => {
    expect(checkAudio(video(), null, { sourceHadAudio: true, sourceSilent: null }).ok).toBe(true)
  })
})

describe('bars', () => {
  const letterboxed = { x: 0, y: 656, w: 1080, h: 608 }

  it('passes full-frame pictures', () => {
    expect(checkBars(video(), [full, full, full]).ok).toBe(true)
  })

  it('flags bars that sit on the same side in every sample', () => {
    const result = checkBars(video(), [letterboxed, letterboxed, letterboxed])
    expect(result.ok).toBe(false)
    expect(result.detail).toContain('top 656px')
    expect(result.detail).toContain('bottom 656px')
  })

  it('does not call a dark scene or one odd frame a bar', () => {
    expect(checkBars(video(), [letterboxed, full, full]).ok).toBe(true)
    const darkScene = { x: 300, y: 800, w: 200, h: 100 }
    expect(barsFromCrops([darkScene, darkScene], video()).samples).toBe(0)
    expect(checkBars(video(), [darkScene, darkScene, darkScene]).ok).toBe(true)
  })

  it('cannot judge from fewer samples than the minimum', () => {
    expect(checkBars(video(), [letterboxed]).ok).toBe(true)
  })

  it('allows a few pixels of encoder edge', () => {
    expect(checkBars(video(), [{ x: 2, y: 2, w: 1076, h: 1916 }, full, full]).ok).toBe(true)
  })
})

describe('watermark and end card', () => {
  it('passes captions only and a matching length', () => {
    expect(checkNoWatermark(ass(), 20, 20).ok).toBe(true)
    expect(checkNoWatermark(null, 20, 20).ok).toBe(true)
  })
  it('flags foreign ASS text, links, and a tail past the plan', () => {
    const marked = `${ass()}Dialogue: 2,0:00:00.00,0:00:20.00,Logo,,0,0,0,,Brand\n`
    expect(checkNoWatermark(marked, 20, 20).detail).toContain('Logo')
    expect(checkNoWatermark(ass().replace('HELLO', 'www.example.com'), 20, 20).ok).toBe(false)
    expect(checkNoWatermark(ass(), 30, 20).ok).toBe(false)
    expect(checkNoWatermark(ass(), 22, 20).ok).toBe(true)
  })
})

describe('captions in the zone', () => {
  it('reads the placement back out of the ASS', () => {
    const layout = captionLayoutFromAss(ass(0.5))
    expect(layout).toMatchObject({ frameWidth: 1080, frameHeight: 1920, fontSize: 88, marginX: 65, centreYMin: 960, centreYMax: 960 })
    expect(layout?.texts).toEqual(['HELLO THERE', 'HELLO THERE'])
    expect(captionLayoutFromAss('[Script Info]\n')).toBeNull()
  })

  it('passes a centred caption and fails one too low', () => {
    expect(checkCaptionsInZone(ass(0.5), SAFE_ZONES.reels).ok).toBe(true)
    const low = checkCaptionsInZone(ass(0.72), SAFE_ZONES.reels)
    expect(low.ok).toBe(false)
    expect(low.detail).toContain('bottom')
    expect(checkCaptionsInZone(ass(0.9), SAFE_ZONES.tiktok).ok).toBe(false)
    expect(checkCaptionsInZone(ass(0.66), SAFE_ZONES.tiktok).ok).toBe(true)
  })

  it('has nothing to check without captions', () => {
    expect(checkCaptionsInZone(null, SAFE_ZONES.reels).ok).toBe(true)
  })
})

describe('evaluateExport', () => {
  const good: ExportMeasurements = { video: video(), audio: { meanDb: -18, maxDb: -1.5 }, crops: [full, full, full] }
  const expects = (over: Partial<ExportExpectations> = {}): ExportExpectations => ({
    format: 'vertical',
    sourceHadAudio: true,
    sourceSilent: false,
    plannedMaxSec: 20,
    ass: ass(0.5),
    zone: SAFE_ZONES.reels,
    layoutIsBlur: false,
    ...over
  })

  it('passes a proper vertical export', () => {
    const r = evaluateExport(good, expects())
    expect(r.checks.every((c) => c.ok)).toBe(true)
    expect(r).toMatchObject({ broken: null, fix: null })
  })

  it('offers the blurred fill for bars in a cam or crop layout, and not when it is the blurred fill already or 16:9', () => {
    const boxed = { ...good, crops: Array(3).fill({ x: 0, y: 300, w: 1080, h: 1320 }) }
    expect(evaluateExport(boxed, expects()).fix).toBe('blur_fill')
    const blur = evaluateExport(boxed, expects({ layoutIsBlur: true }))
    expect(blur.fix).toBeNull()
    expect(blur.checks.every((c) => c.ok)).toBe(true)
    expect(evaluateExport(boxed, expects()).broken).toBeNull()
    const wide = { video: video({ width: 1920, height: 1080 }), audio: good.audio, crops: Array(3).fill({ x: 0, y: 140, w: 1920, h: 800 }) }
    expect(evaluateExport(wide, expects({ format: 'horizontal', ass: null })).fix).toBeNull()
  })

  it('calls a wrong size or dead sound broken and names why', () => {
    const r = evaluateExport({ ...good, video: video({ width: 720, height: 1280 }), audio: { meanDb: -91, maxDb: -91 } }, expects())
    expect(r.broken).toContain('720x1280')
    expect(r.broken).toContain('silent')
  })

  it('checks a 16:9 export at 1920x1080', () => {
    const wide = { video: video({ width: 1920, height: 1080 }), audio: good.audio, crops: Array(3).fill({ x: 0, y: 0, w: 1920, h: 1080 }) }
    expect(evaluateExport(wide, expects({ format: 'horizontal', ass: null })).checks.every((c) => c.ok)).toBe(true)
  })
})
