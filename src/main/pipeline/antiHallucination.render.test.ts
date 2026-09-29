// Counts the words whisper.cpp invents where nobody speaks (silence, noise,
// chords, game-like impacts, all generated) and checks real speech keeps its
// words. Runs the app's own glue (whisperChunk -> parseWhisperJson) on the
// installed CPU whisper build. Two paths are measured: the normal one (VAD on),
// where nothing must come out, and the fallback without the VAD model, where
// whisper answers silence with "Thank you." and the filters must catch it.
// Skips cleanly off Windows, or when FFmpeg, the voice or the speech tools are
// missing.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseWhisperJson } from '../core/transcript'
import { dropIsolatedFiller } from '../core/transcriptQuality'
import { runTool } from '../tools/process'
import { ToolRegistry } from '../tools/registry'
import { dtwPreset, whisperChunk } from './ai'
import { findOnPath, nonSpeechSignals, speak, VOICES, wordAccuracy } from './speechTestKit'

const ffmpeg = findOnPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const toolsDir = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'CrapCut', 'tools') : null
const registry = toolsDir ? new ToolRegistry(toolsDir, join(toolsDir, '_downloads')) : null
const whisper = registry?.path('whisper-cpu') ?? null
const small = registry?.path('model-whisper-small') ?? null
const model = small ?? registry?.path('model-whisper-large') ?? null
const vad = registry?.path('model-vad') ?? null
// The small model stays quiet on silence even without VAD; the large one (a
// GPU job's model) is the one that answers it with "Thank you.", so the
// fallback check uses it when the Vulkan build is installed.
const vulkan = registry?.path('whisper-vulkan') ?? null
const large = registry?.path('model-whisper-large') ?? null

/** Transcribes `wav` in `dir` the way a job does, with or without the VAD model, on the large model on the GPU when `strong`. */
async function transcribe(dir: string, wav: string, withVad: boolean, strong = false): Promise<{ words: { t0: number; t1: number; text: string }[]; vad: boolean }> {
  const gpu = strong && !!vulkan && !!large
  const result = await whisperChunk({
    whisper: gpu ? vulkan! : whisper!,
    cwd: dir,
    model: relative(dir, gpu ? large! : model!),
    vadModel: withVad && vad ? relative(dir, vad) : null,
    audio: wav,
    outBase: 'out',
    language: 'en',
    threads: 4,
    gpu,
    beam: gpu ? 5 : 1,
    dtw: dtwPreset(gpu || model !== small ? 'large' : 'small'),
    signal: new AbortController().signal,
    onProgress: () => {}
  })
  const parsed = parseWhisperJson(JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) as unknown, result)
  return { words: parsed.words, vad: result.vad !== null }
}

describe.skipIf(!ffmpeg || !whisper || !model || !vad)('words invented where nobody speaks', () => {
  it('none on generated silence, noise, chords and impacts', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-hallucination-'))
    try {
      const signal = new AbortController().signal
      const rows: string[] = []
      for (const [i, s] of nonSpeechSignals(40).entries()) {
        const wav = `signal${i}.wav`
        await runTool(ffmpeg!, ['-hide_banner', '-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', s.lavfi, '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', wav], { cwd: dir, signal })
        const normal = await transcribe(dir, wav, true)
        const fallback = await transcribe(dir, wav, false, true)
        const filtered = dropIsolatedFiller(fallback.words)
        rows.push(`${s.name}: ${normal.words.length} words (VAD on), ${fallback.words.length} without VAD, ${filtered.length} after the filter`)
        expect(normal.vad).toBe(true)
        expect(normal.words.map((w) => w.text)).toEqual([])
        expect(filtered.map((w) => w.text)).toEqual([])
      }
      console.info(`invented words per 40 s of audio: ${rows.join('; ')}`)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 600_000)

  it.skipIf(process.platform !== 'win32').each(VOICES)('keeps the words of real speech (%s)', async (voice) => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-hallucination-'))
    try {
      const truth = speak(dir, voice)
      if (!truth || truth.length < 20) return // no Windows voice on this machine
      await runTool(ffmpeg!, ['-hide_banner', '-nostdin', '-y', '-i', 'speech.wav', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.05:sample_rate=16000', '-filter_complex', 'amix=inputs=2:duration=first:normalize=0', '-ac', '1', '-ar', '16000', 'noisy.wav'], { cwd: dir, signal: new AbortController().signal })
      const normal = wordAccuracy(truth, (await transcribe(dir, 'noisy.wav', true)).words)
      const fallback = wordAccuracy(truth, dropIsolatedFiller((await transcribe(dir, 'noisy.wav', false, true)).words))
      console.info(`speech words (${truth.length} spoken): VAD on ${normal.dropped} missed / ${normal.extra} extra; without VAD, filtered, ${fallback.dropped} missed / ${fallback.extra} extra`)
      // Measured on both voices: 0 missed and 0 extra (1 and 1 in all on the large model).
      expect(normal.dropped).toBeLessThanOrEqual(2)
      expect(normal.extra).toBeLessThanOrEqual(2)
      expect(fallback.dropped).toBeLessThanOrEqual(2)
      expect(fallback.extra).toBeLessThanOrEqual(2)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 600_000)
})
