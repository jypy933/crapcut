// Checks caption word timing against speech whose word times are known
// exactly: Windows' built-in voice reads sentences with pauses between them
// and reports the moment each word starts. Runs the app's own glue
// (whisperChunk with DTW -> parseWhisperJson) on the installed CPU whisper
// build, so it measures what a real job gets. Skips cleanly off Windows, or
// when FFmpeg, the voice or the speech tools are missing.

import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseWhisperJson } from '../core/transcript'
import { runTool } from '../tools/process'
import { ToolRegistry } from '../tools/registry'
import { dtwPreset, whisperChunk } from './ai'
import { findOnPath, norm, pair, pauseFrames, pct, secondsOverSilence, speak, truthEnds, voicedFrames, FRAME, VOICES } from './speechTestKit'

const ffmpeg = findOnPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const toolsDir = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'CrapCut', 'tools') : null
const registry = toolsDir ? new ToolRegistry(toolsDir, join(toolsDir, '_downloads')) : null
const whisper = registry?.path('whisper-cpu') ?? null
// The small model is much quicker on the CPU; both measured the same DTW lag.
const small = registry?.path('model-whisper-small') ?? null
const model = small ?? registry?.path('model-whisper-large') ?? null
const vad = registry?.path('model-vad') ?? null

describe.skipIf(!ffmpeg || !whisper || !model || process.platform !== 'win32')('caption word timing (real speech with known word times)', () => {
  it.each(VOICES)('puts words on the voice, never well ahead of it (%s)', async (voice) => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-word-timing-'))
    try {
      const truth = speak(dir, voice)
      if (!truth || truth.length < 20) return // no Windows voice on this machine
      const signal = new AbortController().signal
      // Light noise under the voice, so VAD and whisper do not get a studio recording.
      await runTool(ffmpeg!, ['-hide_banner', '-nostdin', '-y', '-i', 'speech.wav', '-f', 'lavfi', '-i', 'anoisesrc=color=pink:amplitude=0.05:sample_rate=16000', '-filter_complex', 'amix=inputs=2:duration=first:normalize=0', '-ac', '1', '-ar', '16000', 'noisy.wav'], { cwd: dir, signal })
      const result = await whisperChunk({
        whisper: whisper!,
        cwd: dir,
        model: relative(dir, model!),
        vadModel: vad ? relative(dir, vad) : null,
        audio: 'noisy.wav',
        outBase: 'out',
        language: 'en',
        threads: 4,
        gpu: false,
        beam: 1,
        dtw: dtwPreset(model === small ? 'small' : 'large'),
        signal,
        onProgress: () => {}
      })
      const parsed = parseWhisperJson(JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) as unknown, result)
      expect(parsed.dtw).toBe(true)

      const pairs = pair(truth, parsed.words)
      expect(pairs.length).toBeGreaterThan(truth.length * 0.8)
      const errors = pairs.map(([want, got]) => got - want)
      const sorted = errors.map(Math.abs).sort((a, b) => a - b)
      // Measured: median ~60 ms, 90% within ~140 ms. The old timestamps were
      // 215 ms / 615 ms, with most words shown well before they were said.
      expect(sorted[Math.floor(sorted.length / 2)]!).toBeLessThan(0.12)
      expect(sorted[Math.floor(sorted.length * 0.9)]!).toBeLessThan(0.25)
      expect(errors.filter((e) => e < -0.2)).toHaveLength(0)

      // Word ends and time shown over pauses, against the clean voice.
      const voiced = voicedFrames(join(dir, 'speech.wav'))
      const pause = pauseFrames(voiced)
      const ends = truthEnds(truth, voiced, pause)
      const endErrors = truth.flatMap((t, i) => {
        const got = parsed.words.find((g) => norm(g.text) === norm(t.text) && Math.abs(g.t0 - t.t0) < 0.5)
        return got ? [got.t1 - ends[i]!] : []
      })
      const endAbs = endErrors.map(Math.abs).sort((a, b) => a - b)
      const shown = secondsOverSilence(parsed.words, pause)
      const plain = parseWhisperJson(JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) as unknown)
      const plainShown = secondsOverSilence(plain.words, pause)
      const pausedSec = pause.filter(Boolean).length * FRAME
      console.info(
        `word timing: start median ${(pct(sorted, 0.5) * 1000).toFixed(0)} ms, p90 ${(pct(sorted, 0.9) * 1000).toFixed(0)} ms; ` +
          `end median ${(pct(endAbs, 0.5) * 1000).toFixed(0)} ms, p90 ${(pct(endAbs, 0.9) * 1000).toFixed(0)} ms, max ${(endAbs[endAbs.length - 1]! * 1000).toFixed(0)} ms (${endErrors.length} words); ` +
          `over silence ${shown.toFixed(2)} s of ${pausedSec.toFixed(1)} s pauses (whisper's own times: ${plainShown.toFixed(2)} s)`
      )
      // Measured: end median ~30 ms, 90% within ~90 ms (before the VAD end was
      // trimmed: 70 / 190 ms), and 0.2 s over pauses (2.1 s before, 13.9 s with
      // whisper's own timestamps).
      expect(endErrors.length).toBeGreaterThan(truth.length * 0.8)
      expect(pct(endAbs, 0.9)).toBeLessThan(0.15)
      expect(shown).toBeLessThan(0.8)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 300_000)
})
