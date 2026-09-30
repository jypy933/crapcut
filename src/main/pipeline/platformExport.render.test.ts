// Runs the real per-platform export (renderClipToFile with a platform, the way
// the exporter calls it) against tiny FFmpeg-generated sources and checks the
// files with ffprobe: 1080x1920 with sound for each of TikTok, Shorts and
// Reels, a clip over 60 s held to the TikTok/Shorts cap at a phrase end while
// Reels (90 s) keeps all of it, a platform skipped when the speech has no
// clean place to end, and a platform whose file would come out the same
// copying the earlier one instead of encoding it again. Skips cleanly when
// FFmpeg is not on PATH.

import { execFileSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Platform } from '@shared/editPlan'
import type { Clip, HardwareProfile, Word } from '@shared/types'
import { capFit } from '../core/editRules'
import { outputDuration } from '../core/edl'
import { Store } from '../store'
import { runTool } from '../tools/process'
import type { ToolRegistry } from '../tools/registry'
import { resolveAutoEdit } from './autoEditPlan'
import { renderClipToFile, type ClipRenderDeps, type RenderOutcome } from './clipRender'
import { GpuLock } from './gpuLock'
import { probeMedia } from './media'

function findOnPath(name: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' })
    const first = out.split(/\r?\n/).find((l) => l.trim())
    return first?.trim() || null
  } catch {
    return null
  }
}

const ffmpeg = findOnPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const ffprobe = findOnPath(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')
const RESOURCES = resolve(__dirname, '../../../resources')
const PLATFORMS: Platform[] = ['tiktok', 'shorts', 'reels']

async function makeSource(file: string, seconds: number, size: string, rate: number): Promise<void> {
  await runTool(ffmpeg!, [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${size}:rate=${rate}:duration=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${seconds}`,
    '-shortest',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    file
  ])
}

/** Steady speech: `count` words, 0.4 s apart, from `from` (VOD seconds). */
function dense(from: number, count: number): Word[] {
  return Array.from({ length: count }, (_, i) => ({ t0: from + i * 0.4, t1: from + i * 0.4 + 0.3, text: `w${i}` }))
}

/** Sentences of four words with a 0.7 s pause and a full stop after each, from `from` to `to`. */
function sentences(from: number, to: number): Word[] {
  const out: Word[] = []
  for (let t = from; t + 1.5 < to; t += 2.2) for (let i = 0; i < 4; i++) out.push({ t0: t + i * 0.4, t1: t + i * 0.4 + 0.3, text: i === 3 ? `w${out.length}.` : `w${out.length}` })
  return out
}

function makeClip(id: string, jobId: string, over: Partial<Clip>): Clip {
  return {
    id,
    jobId,
    rank: 1,
    score: 0.8,
    title: 'Platform render test',
    start: 1,
    end: 19,
    suggested: { start: 1, end: 19 },
    source: { start: 0, end: 21 },
    status: 'accepted',
    words: [],
    captions: { enabled: true, y: 0.7, uppercase: true, styleId: 'clean' },
    chatMessages: [],
    chatOverlay: false,
    audio: 'original',
    musicPath: null,
    layoutId: null,
    formats: { vertical: true, horizontal: false },
    reason: 'test',
    signals: null,
    structureDecision: null,
    autoEdit: true,
    ...over
  }
}

interface Rig {
  dir: string
  store: Store
  deps: ClipRenderDeps
  clipsDir: string
}

function rig(): Rig {
  const dir = mkdtempSync(join(tmpdir(), 'crapcut-platform-export-'))
  const jobId = 'job-platform'
  const clipsDir = join(dir, 'jobs', jobId, 'clips')
  mkdirSync(clipsDir, { recursive: true })
  const store = new Store(join(dir, 'db.sqlite'))
  const tools = { require: (id: string) => (id === 'ffmpeg' ? ffmpeg! : (() => { throw new Error(`unexpected tool ${id}`) })()) } as unknown as ToolRegistry
  const hw: HardwareProfile = { gpus: [], primary: null, whisper: 'cpu', llm: 'cpu', totalRamMb: 8000, cpuThreads: 4 }
  const deps: ClipRenderDeps = {
    store,
    paths: { root: dir, tools: dir, downloads: dir, jobs: join(dir, 'jobs'), logs: dir, db: join(dir, 'db.sqlite'), output: join(dir, 'output'), resources: RESOURCES },
    tools,
    hw: () => hw,
    gpu: new GpuLock(),
    getEncoder: async () => 'libx264',
    onHwEncoderFailed: () => {}
  }
  return { dir, store, deps, clipsDir }
}

/** Renders `clip` for each platform in turn the way the exporter does: a platform whose signature was seen before copies that file. */
async function exportAll(r: Rig, clip: Clip, platforms: Platform[]): Promise<{ platform: Platform; outcome: RenderOutcome; file: string }[]> {
  const made = new Map<string, string>()
  const out: { platform: Platform; outcome: RenderOutcome; file: string }[] = []
  for (const platform of platforms) {
    const file = join(r.dir, `${clip.id}-${platform}.mp4`)
    const partial = join(r.dir, 'work', platform, 'out.mp4')
    const outcome = await renderClipToFile(r.deps, clip, 'vertical', join(r.dir, 'work', platform), partial, new AbortController().signal, () => {}, {
      platform,
      reuse: (signature) => made.get(signature) ?? null
    })
    if (outcome.kind !== 'skipped') {
      copyFileSync(partial, file)
      made.set(outcome.signature, file)
    }
    out.push({ platform, outcome, file })
  }
  return out
}

describe.skipIf(!ffmpeg || !ffprobe)('per-platform export (real FFmpeg)', () => {
  it('exports an auto-edited clip for TikTok, Shorts and Reels as 1080x1920 with sound, all the same length', async () => {
    const r = rig()
    try {
      const clip = makeClip('clip-platform-auto', 'job-platform', { words: [...dense(1.2, 20), ...dense(14.5, 8)] })
      await makeSource(join(r.clipsDir, `${clip.id}.mp4`), 21, '1280x720', 30)

      const results = await exportAll(r, clip, PLATFORMS)
      const lengths: number[] = []
      for (const { outcome, file } of results) {
        expect(outcome.kind).not.toBe('skipped')
        const info = await probeMedia(ffprobe!, file)
        expect(info.width).toBe(1080)
        expect(info.height).toBe(1920)
        expect(info.hasAudio).toBe(true)
        expect(info.duration).toBeGreaterThan(9.5)
        lengths.push(info.duration)
        // Nothing was over a cap, so nothing was cut and the note stays empty; a version the clip has no cold open for is the straight edit.
        if (outcome.kind !== 'skipped') {
          expect(outcome.note).toBeNull()
          expect(outcome.version).toBe('straight')
        }
      }
      expect(Math.max(...lengths) - Math.min(...lengths)).toBeLessThan(0.3)

      // A chosen cold open the clip does not have falls back to the straight edit rather than failing.
      const asked = await exportAll(r, { ...clip, id: 'clip-platform-auto', version: 'coldOpen' }, ['tiktok'])
      expect(asked[0]!.outcome).toMatchObject({ version: 'straight' })
    } finally {
      r.store.close()
      rmSync(r.dir, { recursive: true, force: true })
    }
  }, 300_000)

  it('encodes once and copies when two platforms would produce the same file', async () => {
    const r = rig()
    try {
      // No captions and no overlays: nothing is fitted to a platform's zone, so all three files come out the same.
      const clip = makeClip('clip-platform-same', 'job-platform', { autoEdit: false, captions: { enabled: false, y: 0.7, uppercase: true, styleId: 'clean' } })
      await makeSource(join(r.clipsDir, `${clip.id}.mp4`), 21, '640x360', 15)

      const results = await exportAll(r, clip, PLATFORMS)
      expect(results.map((x) => x.outcome.kind)).toEqual(['rendered', 'copied', 'copied'])
      const size = statSync(results[0]!.file).size
      for (const { file } of results) {
        expect(statSync(file).size).toBe(size)
        expect((await probeMedia(ffprobe!, file)).duration).toBeGreaterThan(17)
      }
    } finally {
      r.store.close()
      rmSync(r.dir, { recursive: true, force: true })
    }
  }, 300_000)

  it('holds a 64 s clip to 60 s at a phrase end for TikTok and Shorts and gives Reels (90 s) all of it', async () => {
    const r = rig()
    try {
      const clip = makeClip('clip-platform-long', 'job-platform', {
        autoEdit: false,
        captions: { enabled: false, y: 0.7, uppercase: true, styleId: 'clean' },
        start: 1,
        end: 65,
        suggested: { start: 1, end: 65 },
        source: { start: 0, end: 66 },
        words: sentences(1.2, 65)
      })
      await makeSource(join(r.clipsDir, `${clip.id}.mp4`), 66, '640x360', 10)

      const [tiktok, shorts, reels] = await exportAll(r, clip, PLATFORMS)
      if (tiktok!.outcome.kind === 'skipped' || shorts!.outcome.kind === 'skipped' || reels!.outcome.kind === 'skipped') throw new Error('expected exports')

      const tiktokLength = (await probeMedia(ffprobe!, tiktok!.file)).duration
      expect(tiktokLength).toBeLessThanOrEqual(60.2)
      expect(tiktokLength).toBeGreaterThan(55)
      expect(tiktok!.outcome.note).toBe('Ends a few seconds early on TikTok to stay within 60 s.')
      // Shorts has the same cap and the same picture and sound: copied, not encoded again.
      expect(shorts!.outcome.kind).toBe('copied')
      expect((await probeMedia(ffprobe!, shorts!.file)).duration).toBeCloseTo(tiktokLength, 1)
      expect(shorts!.outcome.note).toBe('Ends a few seconds early on Shorts to stay within 60 s.')

      const reelsInfo = await probeMedia(ffprobe!, reels!.file)
      expect(reelsInfo.duration).toBeGreaterThan(63.5)
      expect(reelsInfo.width).toBe(1080)
      expect(reelsInfo.height).toBe(1920)
      expect(reels!.outcome.kind).toBe('rendered')
      expect(reels!.outcome.note).toBeNull()
    } finally {
      r.store.close()
      rmSync(r.dir, { recursive: true, force: true })
    }
  }, 400_000)

  it('leaves a platform out, with a note and no file, when the clip is over its cap and has no clean place to end', async () => {
    const r = rig()
    try {
      const clip = makeClip('clip-platform-skip', 'job-platform', {
        autoEdit: false,
        start: 1,
        end: 65,
        suggested: { start: 1, end: 65 },
        source: { start: 0, end: 66 },
        // Speech with no pause and no full stop anywhere.
        words: dense(1.2, 150)
      })
      await makeSource(join(r.clipsDir, `${clip.id}.mp4`), 66, '320x180', 5)

      const file = join(r.dir, 'skipped.mp4')
      const outcome = await renderClipToFile(r.deps, clip, 'vertical', join(r.dir, 'work-skip'), file, new AbortController().signal, () => {}, { platform: 'tiktok' })
      expect(outcome).toEqual({ kind: 'skipped', note: 'Not made for TikTok: the clip is over 60 s.' })
      expect(existsSync(file)).toBe(false)
    } finally {
      r.store.close()
      rmSync(r.dir, { recursive: true, force: true })
    }
  }, 120_000)
})

/** Like `makeSource`, but the sound is a quiet tone with one loud burst: the payoff a cold open previews. */
async function makeSourceWithBurst(file: string, seconds: number, burst: { from: number; to: number }): Promise<void> {
  await runTool(ffmpeg!, [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=640x360:rate=15:duration=${seconds}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${seconds},volume='if(between(t,${burst.from},${burst.to}),1,0.03)':eval=frame`,
    '-shortest',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    file
  ])
}

/** The word shown highlighted in each caption event, with the second it starts: a group's events share their text, one per word in order. */
function highlightedWords(ass: string): { word: string; t: number }[] {
  const out: { word: string; t: number }[] = []
  let previous = ''
  let index = 0
  for (const line of ass.split(/\r?\n/)) {
    if (!line.startsWith('Dialogue:')) continue
    // Layer, start, end, style, name, three margins, effect, then the text (which has commas of its own).
    const fields = line.slice('Dialogue:'.length).split(',')
    if (fields[3]?.trim() !== 'Caption') continue
    const m = /^(\d+):(\d+):(\d+\.\d+)$/.exec(fields[1]!.trim())
    if (!m) continue
    const text = fields.slice(9).join(',').replace(/\{[^}]*\}/g, '')
    index = text === previous ? index + 1 : 0
    previous = text
    const word = text.split(' ')[index]
    if (word) out.push({ word, t: Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) })
  }
  return out
}

describe.skipIf(!ffmpeg || !ffprobe)('cold-open export (real FFmpeg)', () => {
  it('exports the cold-open version for one platform: planned length, 1080x1920 with sound, no word twice within 2 s', async () => {
    const r = rig()
    try {
      // A 28 s cut with steady speech, one loud burst at 15-17.5 s and a chat burst about 7 s after it (chat lags the audio).
      const chat = Array.from({ length: 12 }, (_, i) => ({ t: 22.5 + i * 0.2, user: `viewer${i}`, text: 'KEKW' }))
      const words = Array.from({ length: 66 }, (_, i) => ({ t0: 1.2 + i * 0.4, t1: 1.2 + i * 0.4 + 0.3, text: `w${i}` }))
      const clip = makeClip('clip-platform-cold', 'job-platform', {
        start: 1,
        end: 29,
        suggested: { start: 1, end: 29 },
        source: { start: 0, end: 30 },
        words,
        chatMessages: chat,
        // The plan as the rule engine stored it: a qualifying cold open, model-confirmed, its payoff near 15.5 s.
        // (An export re-plans from the clip's own signals and keeps this verdict while the payoff has not moved.)
        editPlan: {
          finalSec: 28,
          editSkipped: false,
          extendedSec: 0,
          belowFloor: false,
          capFit: capFit(28),
          coldOpen: { qualifies: true, confidence: 0.8, llm: 'confirmed', payoffVodSec: 15.5, previewSec: 2.5, finalSec: 30.5, segments: [{ srcStart: 14.9, srcEnd: 17.4 }], capFit: capFit(30.5), reasons: ['hand-made'] },
          loop: { eligible: false, endSec: null, seamScore: null, loudnessDiffLu: null, quietSec: null, calibrated: false }
        },
        version: 'coldOpen'
      })
      await makeSourceWithBurst(join(r.clipsDir, `${clip.id}.mp4`), 30, { from: 15, to: 17.5 })

      // What the export will build, read from the same planner it calls.
      const planned = await resolveAutoEdit(r.store, { ffmpeg: ffmpeg!, input: join(r.clipsDir, `${clip.id}.mp4`), clip, window: { start: 1, end: 29 }, cam: null, signal: new AbortController().signal })
      expect(planned.coldOpenEdl, `cold open did not qualify: ${planned.plan.coldOpen.reasons.join('; ')}`).not.toBeNull()
      const expected = outputDuration(planned.coldOpenEdl!)
      expect(expected).toBeGreaterThan(outputDuration(planned.edl) + 1.4)

      const work = join(r.dir, 'work-cold')
      const file = join(r.dir, 'cold-reels.mp4')
      const outcome = await renderClipToFile(r.deps, clip, 'vertical', work, file, new AbortController().signal, () => {}, { platform: 'reels' })
      expect(outcome).toMatchObject({ kind: 'rendered', version: 'coldOpen', note: null })
      if (outcome.kind === 'skipped') return
      expect(outcome.finalSec).toBeCloseTo(expected, 5)

      const info = await probeMedia(ffprobe!, file)
      expect(info.width).toBe(1080)
      expect(info.height).toBe(1920)
      expect(info.hasAudio).toBe(true)
      expect(Math.abs(info.duration - expected)).toBeLessThan(0.2)

      // The captions burned in: the preview's words show once up front and again in the replay, far apart, never twice close together.
      const shown = highlightedWords(readFileSync(join(work, 'captions.ass'), 'utf8')).map((s) => ({ ...s, word: s.word.toLowerCase() }))
      expect(shown.length).toBeGreaterThan(20)
      const byWord = new Map<string, number[]>()
      for (const s of shown) byWord.set(s.word, [...(byWord.get(s.word) ?? []), s.t])
      let replayed = 0
      for (const times of byWord.values()) {
        for (let i = 1; i < times.length; i++) expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(2)
        if (times.length > 1) replayed++
      }
      expect(replayed).toBeGreaterThanOrEqual(3)
    } finally {
      r.store.close()
      rmSync(r.dir, { recursive: true, force: true })
    }
  }, 300_000)
})
