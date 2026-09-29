// Runs the actual clip-captions glue (cutAudioSegment -> whisper-cli ->
// parseWhisperJson -> placeChunkWords) against a real FFmpeg-generated audio
// file and whichever real, currently-installed speech model is on this
// machine. Only reads and runs the app's own installed copies under
// %LOCALAPPDATA%\CrapCut\tools -- never writes there. Skips cleanly when
// FFmpeg is not on PATH or nothing is installed, so CI and a fresh checkout
// still pass `npm test`.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { placeChunkWords, parseWhisperJson } from '../core/transcript'
import { resolvePaths } from '../paths'
import { runTool } from '../tools/process'
import { ToolRegistry } from '../tools/registry'
import { whisperChunk } from './ai'
import { cutAudioSegment } from './media'

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

// Never created if missing: `resolvePaths` would create the folder, so the
// location is worked out by hand instead of calling it.
const toolsDir = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'CrapCut', 'tools') : null
const registry = toolsDir ? new ToolRegistry(toolsDir, join(toolsDir, '_downloads')) : null
const whisper = registry?.path('whisper-cpu') ?? null
// Whichever model this machine actually has installed; the glue is the same either way.
const model = registry?.path('model-whisper-large') ?? registry?.path('model-whisper-small') ?? null
const vad = registry?.path('model-vad') ?? null

describe.skipIf(!ffmpeg || !whisper || !model)('clip captions glue (real FFmpeg and whisper-cli)', () => {
  it('cuts a range, transcribes it and offsets the words back onto the VOD timeline', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-clip-captions-'))
    const signal = new AbortController().signal
    try {
      // A 6 s tone stands in for the full VOD audio; real speech is not
      // needed to prove the plumbing works end to end.
      const full = join(dir, 'full.wav')
      await runTool(ffmpeg!, ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', 'sine=frequency=220:duration=6', '-ac', '1', '-ar', '16000', full], { cwd: dir, signal })

      const range = { start: 1, end: 5 }
      const cut = join(dir, 'cut.wav')
      await cutAudioSegment(ffmpeg!, dir, relative(dir, full), range.start, range.end - range.start, relative(dir, cut), signal)

      const outBase = join(dir, 'out')
      await whisperChunk({
        whisper: whisper!,
        cwd: dir,
        model: relative(dir, model!),
        vadModel: vad ? relative(dir, vad) : null,
        audio: relative(dir, cut),
        outBase: relative(dir, outBase),
        language: 'en',
        threads: 2,
        gpu: false,
        beam: 1,
        signal,
        onProgress: () => {}
      })

      const raw = JSON.parse(readFileSync(`${outBase}.json`, 'utf8')) as unknown
      const parsed = parseWhisperJson(raw)
      expect(Array.isArray(parsed.words)).toBe(true)

      // Whatever whisper made of a tone, offsetting must land inside the range.
      const placed = placeChunkWords(parsed.words, range).words
      for (const word of placed) {
        expect(word.t0).toBeGreaterThanOrEqual(range.start)
        expect(word.t1).toBeLessThanOrEqual(range.end + 1)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
