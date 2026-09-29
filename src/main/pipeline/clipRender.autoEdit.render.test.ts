// Runs the real export wiring (renderClipToFile -> renderAutoEditToFile) for
// an auto-edited clip against a tiny FFmpeg-generated source, and checks the
// result with ffprobe. This is the glue `viralEdit.render.test.ts` does not
// cover: picking up a clip's structure decision (or computing one lazily),
// building the SFX cache, remapping captions and choosing the encoder, all
// through the same function a normal export calls. Skips cleanly when
// FFmpeg is not on PATH -- CI and any machine without FFmpeg still pass
// `npm test`.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { Clip, HardwareProfile } from '@shared/types'
import { renderClipToFile, type ClipRenderDeps } from './clipRender'
import { GpuLock } from './gpuLock'
import { probeMedia } from './media'
import { runTool } from '../tools/process'
import type { ToolRegistry } from '../tools/registry'
import { Store } from '../store'

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

const SOURCE_LEN = 16
const CLIP_START = 2
const CLIP_END = 12

async function makeSourceClip(file: string): Promise<void> {
  await runTool(ffmpeg!, [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=1280x720:rate=30:duration=${SOURCE_LEN}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${SOURCE_LEN}`,
    '-shortest',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    file
  ])
}

function makeClip(id: string, jobId: string): Clip {
  // Two short bursts of speech with a long, silent gap between them --
  // trimSilences (inside buildViralEdl, every structure) should collapse
  // that gap, so the auto-edited render comes out visibly shorter than the
  // plain 10 s cut.
  const burst = (start: number): { t0: number; t1: number; text: string }[] => [
    { t0: start, t1: start + 0.3, text: 'okay' },
    { t0: start + 0.35, t1: start + 0.65, text: 'watch' },
    { t0: start + 0.7, t1: start + 1.0, text: 'this' }
  ]
  return {
    id,
    jobId,
    rank: 1,
    score: 0.8,
    title: 'Auto-edit render test',
    start: CLIP_START,
    end: CLIP_END,
    suggested: { start: CLIP_START, end: CLIP_END },
    source: { start: 0, end: SOURCE_LEN },
    status: 'accepted',
    words: [...burst(CLIP_START + 0.2), ...burst(CLIP_END - 1.5)],
    captions: { enabled: true, y: 0.7, uppercase: true, styleId: 'clean' },
    chatMessages: [],
    chatOverlay: false,
    audio: 'original',
    musicPath: null,
    layoutId: null,
    formats: { vertical: false, horizontal: true },
    reason: 'test',
    signals: null,
    structureDecision: null,
    autoEdit: true
  }
}

describe.skipIf(!ffmpeg || !ffprobe)('auto-edit export wiring (real FFmpeg)', () => {
  it('renders a clip with autoEdit on through the real EDL path, shorter than the plain cut', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-autoedit-export-'))
    try {
      const jobId = 'job-autoedit-1'
      const clipsDir = join(dir, 'jobs', jobId, 'clips')
      mkdirSync(clipsDir, { recursive: true })
      const clip = makeClip('clip-autoedit-1', jobId)
      await makeSourceClip(join(clipsDir, `${clip.id}.mp4`))

      const store = new Store(join(dir, 'db.sqlite'))
      try {
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

        const output = join(dir, 'auto-edit-out.mp4')
        await renderClipToFile(deps, clip, 'horizontal', join(dir, 'work-auto'), output, new AbortController().signal, () => {})

        const out = await probeMedia(ffprobe!, output)
        expect(out.width).toBe(1920)
        expect(out.height).toBe(1080)
        expect(out.hasAudio).toBe(true)
        // The plain cut is 10 s; trimming the long silent gap between the two
        // speech bursts should make the auto-edited render clearly shorter.
        expect(out.duration).toBeLessThan(CLIP_END - CLIP_START - 1)
        expect(out.duration).toBeGreaterThan(1)

        // The house-look SFX got rendered once into the tools cache.
        expect(existsSync(join(dir, 'sfx', 'boom.wav'))).toBe(true)

        // A structure decision was computed lazily (the clip had none) and
        // did not need to be saved back by this render call itself.
        expect(clip.structureDecision).toBeNull()

        // Turning the automatic edit off falls back to the plain export,
        // which keeps the full (minus final trim) 10 s cut.
        const plainOutput = join(dir, 'plain-out.mp4')
        await renderClipToFile(deps, { ...clip, autoEdit: false }, 'horizontal', join(dir, 'work-plain'), plainOutput, new AbortController().signal, () => {})
        const plain = await probeMedia(ffprobe!, plainOutput)
        expect(plain.duration).toBeGreaterThan(CLIP_END - CLIP_START - 0.5)
      } finally {
        store.close()
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 120_000)
})
