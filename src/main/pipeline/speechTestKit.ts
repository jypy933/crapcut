// Shared helpers for the render tests that run the real speech tools: find
// FFmpeg on PATH, make speech whose word times are known exactly (Windows'
// built-in voice reports the moment each word starts) and score a transcript
// against it. Not a test itself; imported only by `*.render.test.ts`.

import { execFileSync } from 'node:child_process'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { envelope } from '../core/align'

export function findOnPath(name: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' })
    return out.split(/\r?\n/).find((l) => l.trim())?.trim() || null
  } catch {
    return null
  }
}

export const VOICES = ['Microsoft David Desktop', 'Microsoft Zira Desktop']

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

/** Speaks the test script into `dir/speech.wav`; the spoken words with their exact start times, or null with no Windows voice. */
export function speak(dir: string, voice: string): { t0: number; text: string }[] | null {
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

export const norm = (s: string): string => s.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')

/** Pairs each spoken word with the transcribed word of the same text, in order. */
export function pair(truth: { t0: number; text: string }[], got: { t0: number; text: string }[]): [number, number][] {
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

/**
 * Word accuracy against the spoken words: how many were missed and how many
 * transcribed words were never spoken (longest common subsequence of the two
 * word lists, so one misheard word is one miss and one extra).
 */
export function wordAccuracy(truth: { text: string }[], got: { text: string }[]): { dropped: number; extra: number } {
  const a = truth.map((w) => norm(w.text))
  const b = got.map((w) => norm(w.text))
  const dp = Array.from({ length: a.length + 1 }, () => new Int32Array(b.length + 1))
  for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! + 1 : Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!)
  const common = dp[a.length]![b.length]!
  return { dropped: a.length - common, extra: b.length - common }
}

export const FRAME = 0.01

/** The clean voice as 10 ms frames: true where the voice is speaking (louder than -40 dB of its peak). */
export function voicedFrames(wavPath: string): boolean[] {
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
export function pauseFrames(voiced: boolean[]): boolean[] {
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
export function truthEnds(truth: { t0: number }[], voiced: boolean[], pause: boolean[]): number[] {
  return truth.map((w, i) => {
    const to = Math.min(pause.length, Math.round((truth[i + 1]?.t0 ?? pause.length * FRAME) / FRAME))
    let f = Math.round(w.t0 / FRAME)
    while (f < to && !voiced[f]) f++
    while (f < to && !pause[f]) f++
    return f * FRAME
  })
}

/** Seconds during which some word is on screen while the voice is in a pause. */
export function secondsOverSilence(words: { t0: number; t1: number }[], pause: boolean[]): number {
  let sum = 0
  for (const w of words) for (let f = Math.max(0, Math.floor(w.t0 / FRAME)); f < Math.min(pause.length, Math.ceil(w.t1 / FRAME)); f++) if (pause[f]) sum += FRAME
  return sum
}

export const pct = (sorted: number[], q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!

const note = (f: number): string => `(sin(2*PI*${f}*t)+0.5*sin(4*PI*${f}*t)+0.25*sin(6*PI*${f}*t))`
// Am, F, C, G, two seconds each, three voices.
const CHORDS = [
  [220, 261.63, 329.63],
  [174.61, 220, 261.63],
  [261.63, 329.63, 392],
  [196, 246.94, 293.66]
]
const chordVoice = (v: number): string => `if(lt(mod(t,8),2),${note(CHORDS[0]![v]!)},if(lt(mod(t,8),4),${note(CHORDS[1]![v]!)},if(lt(mod(t,8),6),${note(CHORDS[2]![v]!)},${note(CHORDS[3]![v]!)})))`

/** FFmpeg `-f lavfi -i` sources of `sec` seconds of audio with no speech in it: silence, two noise levels, chords, game-like impacts. */
export function nonSpeechSignals(sec: number): { name: string; lavfi: string }[] {
  return [
    { name: 'silence', lavfi: `anullsrc=r=16000:cl=mono:d=${sec}` },
    { name: 'pink noise', lavfi: `anoisesrc=color=pink:amplitude=0.05:sample_rate=16000:duration=${sec}` },
    { name: 'loud pink noise', lavfi: `anoisesrc=color=pink:amplitude=0.3:sample_rate=16000:duration=${sec}` },
    { name: 'chords', lavfi: `aevalsrc='0.08*(${chordVoice(0)}+${chordVoice(1)}+${chordVoice(2)})*(0.6+0.4*exp(-4*mod(t,0.5)))':s=16000:d=${sec}` },
    { name: 'game impacts', lavfi: `aevalsrc='0.4*random(0)*exp(-6*mod(t,1.7))+0.15*random(1)*exp(-10*mod(t,0.45))+0.05*sin(2*PI*55*t)':s=16000:d=${sec}` }
  ]
}
