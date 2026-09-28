import { describe, expect, it } from 'vitest'
import { ClipPatchSchema } from '@shared/ipc'
import type { Clip } from '@shared/types'
import { applyClipPatch, cleanWords, resetClip } from './clips'

const clip: Clip = {
  id: 'clip-1',
  jobId: 'job-1',
  rank: 1,
  score: 0.8,
  title: 'Original',
  start: 100,
  end: 130,
  suggested: { start: 100, end: 130 },
  source: { start: 80, end: 150 },
  status: 'pending',
  words: [],
  captions: { enabled: true, y: 0.7, uppercase: true },
  audio: 'original',
  musicPath: null,
  layoutId: null,
  formats: { vertical: true, horizontal: false },
  reason: 'Chat spike',
  signals: { chatZ: 3, audioZ: 0.5, score: 0.6, rating: null, source: 'chat' }
}

const apply = (patch: object): Clip => applyClipPatch(clip, ClipPatchSchema.parse(patch), (id) => id === 'layout-1', 5000)

describe('applyClipPatch', () => {
  it('changes simple fields', () => {
    expect(apply({ title: '  New\ntitle ', status: 'accepted', audio: 'voice', formats: { vertical: true, horizontal: true } })).toMatchObject({
      title: 'New title',
      status: 'accepted',
      audio: 'voice',
      formats: { vertical: true, horizontal: true }
    })
  })

  it('keeps cuts inside the downloaded video', () => {
    expect(apply({ start: 50 })).toMatchObject({ start: 80, end: 130 })
    expect(apply({ end: 400 })).toMatchObject({ start: 100, end: 150 })
    expect(apply({ start: 120, end: 110 })).toMatchObject({ start: 110, end: 120 })
    expect(apply({ start: 129.5 })).toMatchObject({ start: 129.5, end: 132.5 })
  })

  it('only accepts known layouts', () => {
    expect(apply({ layoutId: 'layout-1' }).layoutId).toBe('layout-1')
    expect(apply({ layoutId: 'layout-9' }).layoutId).toBeNull()
  })

  it('cleans edited words', () => {
    expect(apply({ words: [{ t0: 2, t1: 1, text: ' b ' }, { t0: 0, t1: 0.5, text: 'a' }, { t0: 3, t1: 4, text: '   ' }] }).words).toEqual([
      { t0: 0, t1: 0.5, text: 'a' },
      { t0: 1, t1: 2, text: 'b' }
    ])
  })

  it('rejects fields the UI may not set', () => {
    expect(() => ClipPatchSchema.parse({ musicPath: 'C:\\evil.exe' })).toThrow()
    expect(() => ClipPatchSchema.parse({ source: { start: 0, end: 1 } })).toThrow()
    expect(() => ClipPatchSchema.parse({ start: -5 })).toThrow()
    expect(() => ClipPatchSchema.parse({ captions: { enabled: true, y: 3, uppercase: true } })).toThrow()
  })
})

describe('helpers', () => {
  it('resets to the suggestion', () => {
    expect(resetClip({ ...clip, start: 90, end: 140 })).toMatchObject({ start: 100, end: 130 })
  })
  it('cleans words', () => {
    expect(cleanWords([])).toEqual([])
  })
})
