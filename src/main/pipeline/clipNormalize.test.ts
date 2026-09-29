// A database saved before the chat overlay existed has clip rows with no
// chatMessages/chatOverlay in their JSON, even though `Clip` says both are
// always there -- Store.clip()/clips() just JSON.parse the row. These tests
// simulate that old row and confirm normalizing fixes it up and saves once.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Clip } from '@shared/types'
import { jobDir, type AppPaths } from '../paths'
import { Store } from '../store'
import { ensureClipNormalized, ensureClipsNormalized, needsNormalizing, normalizeClip } from './clipNormalize'

const baseClip = (over: Partial<Clip> = {}): Clip => ({
  id: 'c1',
  jobId: 'job-1',
  rank: 1,
  score: 0.5,
  title: 'Clip 1',
  start: 100,
  end: 130,
  suggested: { start: 100, end: 130 },
  source: { start: 80, end: 150 },
  status: 'accepted',
  words: [],
  captions: { enabled: true, y: 0.7, uppercase: true, styleId: 'clean' },
  chatMessages: [],
  chatOverlay: false,
  audio: 'original',
  musicPath: null,
  layoutId: null,
  formats: { vertical: true, horizontal: false },
  reason: 'Chat spike',
  signals: null,
  structureDecision: { structure: 'tightCut', loopEnding: false, emphasisWords: [], reasons: ['plain cut, nothing else stood out'] },
  autoEdit: true,
  ...over
})

/** A row saved by a database from before the chat overlay: no chatMessages/chatOverlay at all. */
function oldRow(over: Partial<Clip> = {}): Clip {
  const clip = baseClip(over) as unknown as Record<string, unknown>
  delete clip.chatMessages
  delete clip.chatOverlay
  return clip as unknown as Clip
}

/** A row saved by a database from before the automatic viral edit: no autoEdit/structureDecision at all. */
function preAutoEditRow(over: Partial<Clip> = {}): Clip {
  const clip = baseClip(over) as unknown as Record<string, unknown>
  delete clip.autoEdit
  delete clip.structureDecision
  return clip as unknown as Clip
}

describe('needsNormalizing / normalizeClip (pure)', () => {
  it('flags a clip missing both fields, as an old database row would be', () => {
    expect(needsNormalizing(oldRow())).toBe(true)
  })

  it('flags a clip missing just one of the two fields', () => {
    const noChatOverlay = baseClip() as unknown as Record<string, unknown>
    delete noChatOverlay.chatOverlay
    expect(needsNormalizing(noChatOverlay as unknown as Clip)).toBe(true)

    const noChatMessages = baseClip() as unknown as Record<string, unknown>
    delete noChatMessages.chatMessages
    expect(needsNormalizing(noChatMessages as unknown as Clip)).toBe(true)
  })

  it('does not flag a clip that already has both fields, even when empty/false', () => {
    expect(needsNormalizing(baseClip({ chatMessages: [], chatOverlay: false }))).toBe(false)
  })

  it('fills in the missing fields from the given chat messages', () => {
    const messages = [{ t: 105, user: 'a', text: 'hi' }]
    const next = normalizeClip(oldRow(), messages)
    expect(next.chatOverlay).toBe(false)
    expect(next.chatMessages).toBe(messages)
  })

  it('keeps an already-normal clip untouched, ignoring the given messages', () => {
    const own = [{ t: 1, user: 'x', text: 'own' }]
    const clip = baseClip({ chatMessages: own, chatOverlay: true })
    const next = normalizeClip(clip, [{ t: 2, user: 'y', text: 'other' }])
    expect(next).toEqual(clip)
  })

  it('flags a clip missing autoEdit or structureDecision', () => {
    expect(needsNormalizing(preAutoEditRow())).toBe(true)

    const noAutoEdit = baseClip() as unknown as Record<string, unknown>
    delete noAutoEdit.autoEdit
    expect(needsNormalizing(noAutoEdit as unknown as Clip)).toBe(true)

    expect(needsNormalizing(baseClip({ structureDecision: null }))).toBe(true)
  })

  it('fills in a default autoEdit and computes a structure decision heuristically', () => {
    const next = normalizeClip(preAutoEditRow(), [])
    expect(next.autoEdit).toBe(true)
    expect(next.structureDecision).not.toBeNull()
    expect(next.structureDecision!.structure).toBeDefined()
  })

  it('keeps an existing autoEdit choice and decision instead of recomputing', () => {
    const decision = { structure: 'tightCut' as const, loopEnding: false, emphasisWords: [], reasons: ['kept'] }
    const clip = baseClip({ autoEdit: false, structureDecision: decision })
    const next = normalizeClip(clip, [])
    expect(next.autoEdit).toBe(false)
    expect(next.structureDecision).toBe(decision)
  })
})

describe('ensureClipNormalized / ensureClipsNormalized (I/O)', () => {
  let dir = ''
  let store: Store
  let paths: AppPaths

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crapcut-clipnorm-'))
    store = new Store(join(dir, 'db.sqlite'))
    paths = { root: dir, tools: dir, downloads: dir, jobs: join(dir, 'jobs'), logs: dir, db: '', output: dir, resources: dir }
  })

  afterEach(() => {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  })

  function writeChat(jobId: string, text: string): void {
    mkdirSync(jobDir(paths, jobId), { recursive: true })
    writeFileSync(join(jobDir(paths, jobId), 'chat.txt'), text)
  }

  it('windows the job chat over the clip padded range and saves once', async () => {
    const jobId = store.createJob('u', 'v1')
    // The padded range is 100-20=80 .. 130+20=150; "early" and "late" fall
    // outside it, only "mid" should survive the windowing.
    writeChat(jobId, ['[0:01:00] early: too early', '[0:01:50] mid: in range', '[0:02:40] late: too late'].join('\n'))
    const clip = oldRow({ id: 'c1', jobId, start: 100, end: 130 })
    store.replaceClips(jobId, [clip])

    const normalized = await ensureClipNormalized(store, paths, clip)
    expect(normalized.chatOverlay).toBe(false)
    expect(normalized.chatMessages.map((m) => m.user)).toEqual(['mid'])

    // Saved once: reading it back from the store already has the fields.
    const saved = store.clip('c1')!
    expect(saved.chatMessages.map((m) => m.user)).toEqual(['mid'])
    expect(saved.chatOverlay).toBe(false)
  })

  it('is a no-op for a clip that is already normalized', async () => {
    const jobId = store.createJob('u', 'v2')
    const clip = baseClip({ id: 'c1', jobId, chatMessages: [{ t: 1, user: 'kept', text: 'hi' }], chatOverlay: true })
    store.replaceClips(jobId, [clip])
    const result = await ensureClipNormalized(store, paths, clip)
    expect(result).toBe(clip)
  })

  it('uses an empty chat list when chat.txt is missing', async () => {
    const jobId = store.createJob('u', 'v3')
    const clip = oldRow({ id: 'c1', jobId })
    store.replaceClips(jobId, [clip])
    const normalized = await ensureClipNormalized(store, paths, clip)
    expect(normalized.chatMessages).toEqual([])
    expect(normalized.chatOverlay).toBe(false)
  })

  it('normalizes a whole job of old clips, reading chat.txt once for all of them', async () => {
    const jobId = store.createJob('u', 'v4')
    writeChat(jobId, ['[0:01:45] a: in first clip', '[0:03:20] b: in second clip'].join('\n'))
    const clips = [
      oldRow({ id: 'c1', jobId, start: 100, end: 110 }),
      oldRow({ id: 'c2', jobId, start: 195, end: 210 }),
      baseClip({ id: 'c3', jobId, start: 300, end: 310, chatMessages: [], chatOverlay: true })
    ]
    store.replaceClips(jobId, clips)

    const result = await ensureClipsNormalized(store, paths, clips)
    expect(result.find((c) => c.id === 'c1')!.chatMessages.map((m) => m.user)).toEqual(['a'])
    expect(result.find((c) => c.id === 'c2')!.chatMessages.map((m) => m.user)).toEqual(['b'])
    // Already-normal clip is untouched (its own chatOverlay stays true).
    expect(result.find((c) => c.id === 'c3')!.chatOverlay).toBe(true)

    for (const c of result) expect(needsNormalizing(c)).toBe(false)
  })

  it('returns the same clips untouched when none need normalizing', async () => {
    const jobId = store.createJob('u', 'v5')
    const clips = [baseClip({ id: 'c1', jobId }), baseClip({ id: 'c2', jobId })]
    const result = await ensureClipsNormalized(store, paths, clips)
    expect(result).toBe(clips)
  })
})
