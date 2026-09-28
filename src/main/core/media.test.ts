import { describe, expect, it } from 'vitest'
import { mergeRanges, overlapSeconds, parseLoudnessLog, parseMutedSegments } from './media'

describe('parseMutedSegments', () => {
  it('finds and merges muted segments', () => {
    const pl = [
      '#EXTM3U',
      '#EXT-X-TARGETDURATION:10',
      '#EXT-X-MAP:URI="init-0.mp4"',
      '#EXTINF:10.000,',
      '0.mp4',
      '#EXTINF:10.000,',
      '1-muted.mp4',
      '#EXT-X-PROGRAM-DATE-TIME:2026-09-25T16:06:48.457Z',
      '#EXTINF:10.000,',
      '2-muted.mp4',
      '#EXTINF:10.000,',
      '3-unmuted.mp4',
      '#EXTINF:4.5,',
      '4-muted.ts?token=x',
      '#EXT-X-ENDLIST'
    ].join('\n')
    expect(parseMutedSegments(pl)).toEqual([
      { start: 10, end: 30 },
      { start: 40, end: 44.5 }
    ])
  })
  it('returns nothing for a clean playlist', () => {
    expect(parseMutedSegments('#EXTM3U\n#EXTINF:10,\n0.ts\n')).toEqual([])
  })
})

describe('parseLoudnessLog', () => {
  it('reads per-second RMS and treats -inf as silence', () => {
    const log = [
      'frame:0    pts:0       pts_time:0',
      'lavfi.astats.Overall.RMS_level=-23.5',
      'frame:1    pts:8000    pts_time:1',
      'lavfi.astats.Overall.RMS_level=-inf',
      'frame:2    pts:16000   pts_time:2',
      'lavfi.astats.Overall.RMS_level=-10.25'
    ].join('\r\n')
    expect(Array.from(parseLoudnessLog(log, 4))).toEqual([-23.5, -120, -10.25, -120])
  })
})

describe('ranges', () => {
  it('merges and measures overlap', () => {
    expect(mergeRanges([{ start: 5, end: 8 }, { start: 0, end: 2 }, { start: 7, end: 10 }])).toEqual([
      { start: 0, end: 2 },
      { start: 5, end: 10 }
    ])
    expect(overlapSeconds({ start: 0, end: 10 }, [{ start: 8, end: 20 }, { start: -5, end: 1 }])).toBe(3)
  })
})
