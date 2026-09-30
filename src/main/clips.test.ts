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
  captions: { enabled: true, y: 0.7, uppercase: true, styleId: 'clean' },
  chatMessages: [],
  chatOverlay: false,
  audio: 'original',
  musicPath: null,
  layoutId: null,
  formats: { vertical: true, horizontal: false },
  reason: 'Chat spike',
  signals: { chatZ: 3, audioZ: 0.5, score: 0.6, rating: null, source: 'chat' },
  structureDecision: null,
  autoEdit: true
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
    // A trim never leaves less than the 10 s final-length floor.
    expect(apply({ start: 129.5 })).toMatchObject({ start: 129.5, end: 139.5 })
    expect(apply({ start: 145, end: 148 })).toMatchObject({ start: 140, end: 150 })
    expect(apply({ end: 102 })).toMatchObject({ start: 100, end: 110 })
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

  it('toggles the automatic edit', () => {
    expect(apply({ autoEdit: false }).autoEdit).toBe(false)
  })

  it('switches the version, storing the straight edit as no field', () => {
    const cold = apply({ version: 'coldOpen' })
    expect(cold.version).toBe('coldOpen')
    const back = applyClipPatch(cold, ClipPatchSchema.parse({ version: 'straight' }), () => true, 5000)
    expect('version' in back).toBe(false)
    // Other edits leave it alone, and a clip without one still loads.
    expect(clip.version).toBeUndefined()
    expect(applyClipPatch(cold, ClipPatchSchema.parse({ title: 'Renamed' }), () => true, 5000).version).toBe('coldOpen')
    // Only the two versions are accepted.
    expect(() => ClipPatchSchema.parse({ version: 'loop' })).toThrow()
  })

  it('recomputes the structure decision on a trim, without touching it otherwise', () => {
    expect(apply({ title: 'Renamed' }).structureDecision).toBe(clip.structureDecision)
    const trimmed = apply({ start: 105 })
    expect(trimmed.structureDecision).not.toBeNull()
    expect(trimmed.structureDecision).not.toBe(clip.structureDecision)
  })

  it('saves where the captions and the chat box were dragged', () => {
    const moved = apply({
      captions: { enabled: true, y: 0.5, yHorizontal: 0.85, uppercase: true, styleId: 'clean' },
      chatPos: { vertical: { x: 0.1, y: 0.4 } }
    })
    expect(moved.captions.yHorizontal).toBe(0.85)
    expect(moved.chatPos).toEqual({ vertical: { x: 0.1, y: 0.4 } })
  })

  it('puts the chat box back on its default place for an empty position', () => {
    const placed = applyClipPatch({ ...clip, chatPos: { vertical: { x: 0.1, y: 0.4 } } }, ClipPatchSchema.parse({ chatPos: {} }), () => true, 5000)
    expect('chatPos' in placed).toBe(false)
  })

  it('leaves a clip saved without positions on the defaults', () => {
    expect(clip.chatPos).toBeUndefined()
    expect(apply({ title: 'x' }).chatPos).toBeUndefined()
    expect(apply({ title: 'x' }).captions.yHorizontal).toBeUndefined()
  })

  it('rejects positions outside the frame or with extra fields', () => {
    expect(() => ClipPatchSchema.parse({ chatPos: { vertical: { x: 1.5, y: 0.2 } } })).toThrow()
    expect(() => ClipPatchSchema.parse({ chatPos: { vertical: { x: 0.5, y: 0.2, z: 1 } } })).toThrow()
    expect(() => ClipPatchSchema.parse({ chatPos: { sideways: { x: 0.5, y: 0.2 } } })).toThrow()
    expect(() => ClipPatchSchema.parse({ captions: { enabled: true, y: 0.5, yHorizontal: -1, uppercase: true, styleId: 'clean' } })).toThrow()
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
