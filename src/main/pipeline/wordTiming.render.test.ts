// Checks caption word timing against speech whose word times are known
// exactly: Windows' built-in voice reads sentences with pauses between them
// and reports the moment each word starts. Runs the app's own glue
// (whisperChunk with DTW -> parseWhisperJson) on the installed CPU whisper
// build, so it measures what a real job gets. Skips cleanly off Windows, or
// when FFmpeg, the voice or the speech tools are missing.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { describe, expect, it } from 'vitest'
import { envelope } from '../core/align'
import { parseWhisperJson } from '../core/transcript'
import { runTool } from '../tools/process'
import { ToolRegistry } from '../tools/registry'
import { dtwPreset, whisperChunk } from './ai'

function findOnPath(name: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' })
    return out.split(/\r?\n/).find((l) => l.trim())?.trim() || null
  } catch {
    return null
  }
}

const ffmpeg = findOnPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const toolsDir = process.env.LOCALAPPDATA ? join(process.env.LOCALAPPDATA, 'CrapCut', 'tools') : null
const registry = toolsDir ? new ToolRegistry(toolsDir, join(toolsDir, '_downloads')) : null
const whisper = registry?.path('whisper-cpu') ?? null
// The small model is much quicker on the CPU; both measured the same DTW lag.
const small = registry?.path('model-whisper-small') ?? null
const model = small ?? registry?.path('model-whisper-large') ?? null
const vad = registry?.path('model-vad') ?? null

const VOICES = ['Microsoft David Desktop', 'Microsoft Zira Desktop']

const ssml = (voice: string): string => `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="en-US"><voice name="${voice}">
<break time="1500ms"/>Wait, wait, wait. Did you see that?
<break time="1800ms"/>No way he just jumped off the bridge with the whole squad behind him.
<break time="700ms"/>Chat, I am not doing that again.
<break time="2500ms"/>Okay.
<break time="1200ms"/>Why is it always the same thing, my brother?
<break time="400ms"/>Every single time.
<break time="1500ms"/></voice></speak>`

// Writes the voice's audio as 16 kHz mono WAV and one "ms<TAB>word" line per word.
const SPEAK = `
param([string]$Dir)
Add-Type -AssemblyName System.Speech
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer
$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo(16000, [System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen, [System.Speech.AudioFormat.AudioChannel]::Mono)
$s.SetOutputToWaveFile((Join-Path $Dir 'speech.wav'), $fmt)
$global:words = New-Object System.Collections.ArrayList
$s.add_SpeakProgress({ param($x, $e) [void]$global:words.Add("$($e.AudioPosition.TotalMilliseconds)\`t$($e.Text)") })
$s.SpeakSsml((Get-Content (Join-Path $Dir 'speech.ssml') -Raw))
$s.Dispose()
$global:words | Out-File -Encoding utf8 (Join-Path $Dir 'words.tsv')
`

function speak(dir: string, voice: string): { t0: number; text: string }[] | null {
  if (process.platform !== 'win32') return null
  writeFileSync(join(dir, 'speech.ssml'), ssml(voice))
  writeFileSync(join(dir, 'speak.ps1'), SPEAK)
  try {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', join(dir, 'speak.ps1'), '-Dir', dir], { stdio: 'ignore', timeout: 60_000 })
    return readFileSync(join(dir, 'words.tsv'), 'utf8')
      .replace(/^﻿/, '')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((l) => {
        const [ms, text] = l.split('\t')
        return { t0: Number(ms) / 1000, text: text ?? '' }
      })
  } catch {
    return null
  }
}

const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/** Pairs each spoken word with the transcribed word of the same text, in order. */
function pair(truth: { t0: number; text: string }[], got: { t0: number; text: string }[]): [number, number][] {
  const out: [number, number][] = []
  let j = 0
  for (const t of truth) {
    const k = got.findIndex((g, i) => i >= j && i <= j + 3 && norm(g.text) === norm(t.text))
    if (k < 0) continue
    out.push([t.t0, got[k]!.t0])
    j = k + 1
  }
  return out
}

const FRAME = 0.01

/** The clean voice as 10 ms frames: true where the voice is speaking (louder than -40 dB of its peak). */
function voicedFrames(wavPath: string): boolean[] {
  const buf = readFileSync(wavPath)
  let at = 12
  while (at + 8 <= buf.length && buf.toString('latin1', at, at + 4) !== 'data') at += 8 + buf.readUInt32LE(at + 4)
  const start = at + 8
  const pcm = new Float32Array(Math.floor((buf.length - start) / 2))
  for (let i = 0; i < pcm.length; i++) pcm[i] = buf.readInt16LE(start + i * 2) / 32768
  const env = envelope(pcm, 16000, FRAME)
  const peak = env.reduce((m, v) => Math.max(m, v), 0)
  return Array.from(env, (v) => v > peak * 0.01)
}

/** Frames inside a pause of at least 120 ms (shorter dips are stops inside words, not pauses). */
function pauseFrames(voiced: boolean[]): boolean[] {
  const out = voiced.map(() => false)
  for (let i = 0; i < voiced.length; ) {
    if (voiced[i]) {
      i++
      continue
    }
    let j = i
    while (j < voiced.length && !voiced[j]) j++
    if (j - i >= 12) for (let k = i; k < j; k++) out[k] = true
    i = j
  }
  return out
}

/**
 * Where the voice really stops after each word: where the next pause starts,
 * or else where the next word does. (The voice reports a word after a pause a
 * few frames before it is audible, so the pause it starts in is skipped.)
 */
function truthEnds(truth: { t0: number }[], voiced: boolean[], pause: boolean[]): number[] {
  return truth.map((w, i) => {
    const to = Math.min(pause.length, Math.round((truth[i + 1]?.t0 ?? pause.length * FRAME) / FRAME))
    let f = Math.round(w.t0 / FRAME)
    while (f < to && !voiced[f]) f++
    while (f < to && !pause[f]) f++
    return f * FRAME
  })
}

/** Seconds during which some word is on screen while the voice is in a pause. */
function secondsOverSilence(words: { t0: number; t1: number }[], pause: boolean[]): number {
  let sum = 0
  for (const w of words) for (let f = Math.max(0, Math.floor(w.t0 / FRAME)); f < Math.min(pause.length, Math.ceil(w.t1 / FRAME)); f++) if (pause[f]) sum += FRAME
  return sum
}

const pct = (sorted: number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!

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
