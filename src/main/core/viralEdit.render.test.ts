// Runs the real house-look re-edit (buildViralEdl -> edlToFilterGraph) for
// every structure against a tiny FFmpeg-generated source, and checks the
// result with ffprobe/ebur128/blackdetect. Skips cleanly when FFmpeg is not
// on PATH -- CI and any machine without FFmpeg still pass `npm test`.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ChatMessage, Layout, Word } from '@shared/types'
import { outputDuration } from './edl'
import { buildEdlRenderArgs, edlToFilterGraph, type EdlRenderSpec } from './edlFilter'
import { buildSfxArgs, SFX_KINDS } from './sfx'
import { pickStructure, type StructureDecision } from './structurePick'
import { computeSignals, type ClipFacts } from './structureSignals'
import { buildViralEdl, type ViralEditOptions } from './viralEdit'
import { probeMedia } from '../pipeline/media'
import { runTool } from '../tools/process'

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

const SOURCE_FPS = 60
const SOURCE_SIZE = { width: 1920, height: 1080 }
const CLIP_LENGTH = 24

async function makeSourceClip(file: string): Promise<void> {
  await runTool(ffmpeg!, [
    '-hide_banner',
    '-nostdin',
    '-y',
    '-f',
    'lavfi',
    '-i',
    `testsrc2=size=${SOURCE_SIZE.width}x${SOURCE_SIZE.height}:rate=${SOURCE_FPS}:duration=${CLIP_LENGTH}`,
    '-f',
    'lavfi',
    '-i',
    `sine=frequency=440:sample_rate=48000:duration=${CLIP_LENGTH}`,
    '-shortest',
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    file
  ])
}

const layout: Layout = { id: 'l', name: 'Full', kind: 'center_crop', cam: null, game: { x: 0, y: 0, w: 1, h: 1 } }

async function renderSfx(dir: string): Promise<ViralEditOptions> {
  const sfx: ViralEditOptions['sfx'] = {}
  for (const kind of SFX_KINDS) {
    const file = `${kind}.wav`
    await runTool(ffmpeg!, buildSfxArgs(kind, join(dir, file)))
    sfx[kind] = file
  }
  return { sfx }
}

interface RenderResult {
  width: number
  height: number
  duration: number
  hasAudio: boolean
  audioDuration: number | null
}

async function renderEdl(dir: string, edl: EdlRenderSpec['edl']): Promise<RenderResult> {
  const spec: EdlRenderSpec = {
    input: 'in.mp4',
    source: SOURCE_SIZE,
    sourceFps: SOURCE_FPS,
    format: 'horizontal',
    layout,
    edl,
    captionsAssFile: null,
    overlayAssFile: null,
    fontsDir: null,
    audio: { kind: 'original' },
    loudness: null,
    encoder: 'libx264',
    filterScript: 'graph.txt',
    output: 'out.mp4'
  }
  const { graph } = edlToFilterGraph(spec)
  writeFileSync(join(dir, spec.filterScript), graph)
  await runTool(ffmpeg!, buildEdlRenderArgs(spec), { cwd: dir })

  const out = await probeMedia(ffprobe!, join(dir, spec.output))
  let audioDuration: number | null = null
  if (out.hasAudio) {
    const { stdout } = await runTool(ffprobe!, ['-v', 'error', '-select_streams', 'a:0', '-show_entries', 'stream=duration', '-of', 'csv=p=0', join(dir, spec.output)])
    audioDuration = Number(stdout.trim())
  }
  return { width: out.width, height: out.height, duration: out.duration, hasAudio: out.hasAudio, audioDuration }
}

/** The "Integrated loudness: I: X LUFS" line from ebur128's end-of-stream summary. */
async function measureIntegratedLoudness(file: string): Promise<number> {
  const { stderr } = await runTool(ffmpeg!, ['-hide_banner', '-nostdin', '-i', file, '-af', 'ebur128=framelog=verbose', '-f', 'null', '-'])
  const m = /Integrated loudness:\s*\n\s*I:\s*(-?[\d.]+) LUFS/.exec(stderr)
  if (!m) throw new Error(`no ebur128 summary found:\n${stderr.slice(-2000)}`)
  return Number(m[1])
}

/** True if `blackdetect` found any black stretch in the video. */
async function hasBlackFrames(file: string): Promise<boolean> {
  const { stderr } = await runTool(ffmpeg!, ['-hide_banner', '-nostdin', '-i', file, '-vf', 'blackdetect=d=0.1:pic_th=0.98', '-an', '-f', 'null', '-'])
  return /black_start/.test(stderr)
}

/** A small scaled RGB frame at `atSec`, for a loose visual comparison. */
function extractFrameRgb(file: string, atSec: number, w: number, h: number): Buffer {
  return execFileSync(ffmpeg!, ['-hide_banner', '-nostdin', '-y', '-i', file, '-ss', atSec.toFixed(3), '-frames:v', '1', '-vf', `scale=${w}:${h}:flags=area`, '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-'], {
    maxBuffer: 10 * 1024 * 1024
  })
}

function meanAbsDiff(a: Buffer, b: Buffer): number {
  const n = Math.min(a.length, b.length)
  let sum = 0
  for (let i = 0; i < n; i++) sum += Math.abs(a[i]! - b[i]!)
  return sum / n
}

function facts(partial: Partial<ClipFacts>): ClipFacts {
  return { window: { start: 0, end: CLIP_LENGTH }, words: [], chatMessages: [], loudness: null, loudnessOffset: 0, ...partial }
}

function speech(start: number, n: number, gap: number, wordLen = 0.3, textAt: Record<number, string> = {}): Word[] {
  const out: Word[] = []
  for (let i = 0; i < n; i++) {
    const t0 = start + i * gap
    out.push({ t0, t1: t0 + wordLen, text: textAt[i] ?? 'blah' })
  }
  return out
}

function burstLoudness(totalSec: number, baseDb: number, bursts: { at: number; len: number; db: number }[]): Float64Array {
  const out = new Float64Array(totalSec).fill(baseDb)
  for (const b of bursts) for (let t = Math.max(0, Math.floor(b.at)); t < Math.min(totalSec, Math.ceil(b.at + b.len)); t++) out[t] = b.db
  return out
}

function chatBurst(at: number, len: number, perSec: number): ChatMessage[] {
  const out: ChatMessage[] = []
  for (let t = at; t < at + len; t++) for (let k = 0; k < perSec; k++) out.push({ t: t + k / perSec, user: `u${t}${k}`, text: 'KEKW' })
  return out
}

interface Case {
  name: StructureDecision['structure']
  facts: ClipFacts
  /** Overrides the heuristic pick, for structures (chatFirst) normally only reached via the LLM tie-break. */
  force?: Partial<StructureDecision>
}

const cases: Case[] = [
  {
    name: 'tightCut',
    facts: facts({ words: speech(0, CLIP_LENGTH, 1, 0.3, { 12: 'NO!' }) })
  },
  {
    name: 'payoffFirst',
    facts: facts({ words: speech(0, 20, 0.4), loudness: burstLoudness(CLIP_LENGTH, -50, [{ at: 1, len: 2, db: -5 }]) })
  },
  {
    name: 'quoteCard',
    facts: facts({
      words: [...speech(0, 5, 0.4), ...speech(19, 4, 0.35, 0.3, { 0: 'no', 1: 'way', 2: 'he', 3: 'hit.' })],
      loudness: burstLoudness(CLIP_LENGTH, -50, [{ at: 20, len: 2, db: -5 }])
    })
  },
  {
    name: 'buildAndPunch',
    facts: facts({ words: speech(0, 40, 0.4), loudness: burstLoudness(CLIP_LENGTH, -50, [{ at: 7, len: 2, db: -5 }]) })
  },
  {
    name: 'rapidFire',
    facts: facts({
      loudness: burstLoudness(CLIP_LENGTH, -50, [
        { at: 9, len: 2, db: -5 },
        { at: 16, len: 2, db: -5 },
        { at: 23, len: 1, db: -5 }
      ])
    })
  },
  {
    name: 'freezeLoop',
    facts: facts({ loudness: burstLoudness(CLIP_LENGTH, -25, [{ at: 21, len: 2, db: -5 }]) })
  },
  {
    name: 'chatFirst',
    facts: facts({ words: speech(0, 3, 5), chatMessages: chatBurst(5, 3, 10), loudness: burstLoudness(CLIP_LENGTH, -50, [{ at: 15, len: 2, db: -5 }]) }),
    force: { chatMessageIds: [0, 1, 2] }
  }
]

describe.skipIf(!ffmpeg || !ffprobe)('viral edit house look (real FFmpeg)', () => {
  for (const c of cases) {
    it(`${c.name}: renders a playable, correctly-timed, correctly-loud edit`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `crapcut-viral-${c.name}-`))
      try {
        await makeSourceClip(join(dir, 'in.mp4'))
        const options = await renderSfx(dir)

        const signals = computeSignals(c.facts)
        const decision: StructureDecision = { ...pickStructure(signals, c.facts.words, c.facts.window.start), structure: c.name, ...c.force }
        const edl = buildViralEdl(decision, c.facts, options)

        const out = await renderEdl(dir, edl)
        const frame = 1 / SOURCE_FPS
        expect(out.width).toBe(SOURCE_SIZE.width)
        expect(out.height).toBe(SOURCE_SIZE.height)

        // Duration matches the EDL.
        const expected = outputDuration(edl)
        expect(out.duration).toBeGreaterThan(expected - frame - 0.1)
        expect(out.duration).toBeLessThan(expected + frame + 0.1)

        // A/V stay in sync within 50 ms.
        expect(out.hasAudio).toBe(true)
        expect(out.audioDuration).not.toBeNull()
        expect(Math.abs(out.audioDuration! - out.duration)).toBeLessThan(0.05)

        // No dead black stretches.
        expect(await hasBlackFrames(join(dir, 'out.mp4'))).toBe(false)

        // Loudness lands near the -14 LUFS house target.
        const loudness = await measureIntegratedLoudness(join(dir, 'out.mp4'))
        expect(loudness).toBeGreaterThan(-17)
        expect(loudness).toBeLessThan(-11)

        if (c.name === 'payoffFirst') {
          // The cold open's first frame is the source frame at the cold-open's own start.
          expect(decision.coldOpenSpan).toBeDefined()
          const outFrame = extractFrameRgb(join(dir, 'out.mp4'), 0, 32, 18)
          const srcFrame = extractFrameRgb(join(dir, 'in.mp4'), decision.coldOpenSpan!.start, 32, 18)
          expect(meanAbsDiff(outFrame, srcFrame)).toBeLessThan(20)
        }
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 90_000)
  }
})
