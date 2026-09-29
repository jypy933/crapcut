// Finds whisper.cpp's looping hallucinations in a word list: the same word or
// short phrase repeated back to back far more than a real speaker would
// ("Tired Tired Tired", "of of of", a sentence looping over music or game
// noise). Pure and framework-free, like `wordTiming.ts`, because it is used
// both from the main process (`core/transcriptQuality.ts`, judging whether a
// candidate moment has real speech) and from the renderer's caption preview
// (`captions.ts`), which cannot depend on Node or Electron.

import type { Word } from './types'

export interface LoopOptions {
  /** Longest phrase length (in words) checked for back-to-back repeats. */
  maxNgram: number
  /** A phrase repeated up to this many times in a row is natural speech ("no no no no", "go go go"); more is a loop. */
  maxNaturalRepeats: number
}

export const DEFAULT_LOOP_OPTIONS: LoopOptions = {
  maxNgram: 6,
  maxNaturalRepeats: 4
}

export interface LoopRun {
  /** Index of the run's first word (inclusive). */
  start: number
  /** Index one past the run's last word (exclusive). */
  end: number
  /** How many words make up the repeating phrase. */
  gram: number
  /** How many times it repeated back to back. */
  repeats: number
}

/** Lowercased, letters and digits only, so "it." and "It" match. */
export function normaliseWord(text: string): string {
  return text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

function sameSlice(norms: string[], a: number, b: number, len: number): boolean {
  for (let k = 0; k < len; k++) if (norms[a + k] !== norms[b + k]) return false
  return true
}

/**
 * Finds runs of words where the same word or short phrase (1..`maxNgram`
 * words) repeats immediately after itself more than `maxNaturalRepeats`
 * times. Checking every phrase length separately keeps this linear in the
 * number of words (each index only ever does O(maxNgram) work), so it is
 * cheap enough to run on a whole VOD's transcript.
 */
export function findLoopRuns(words: Word[], opts: LoopOptions = DEFAULT_LOOP_OPTIONS): LoopRun[] {
  const norms = words.map((w) => normaliseWord(w.text))
  const n = norms.length
  const runs: LoopRun[] = []
  for (let gram = 1; gram <= opts.maxNgram; gram++) {
    let i = 0
    while (i + gram <= n) {
      if (!norms[i]) {
        i++
        continue
      }
      let repeats = 1
      let j = i + gram
      while (j + gram <= n && sameSlice(norms, i, j, gram)) {
        repeats++
        j += gram
      }
      if (repeats > opts.maxNaturalRepeats) {
        runs.push({ start: i, end: j, gram, repeats })
        i = j
      } else {
        i++
      }
    }
  }
  return runs
}

/**
 * Collapses each loop run down to its first occurrence, dropping the repeats
 * with their timings, so captions and titles never show "of of of". Natural
 * short repeats (up to `maxNaturalRepeats`) are left untouched. Idempotent:
 * running it again on already-collapsed words changes nothing, so it is safe
 * to apply every time captions or titles are built, like `repairWordTimings`.
 */
export function collapseLoops(words: Word[], opts: LoopOptions = DEFAULT_LOOP_OPTIONS): Word[] {
  const runs = findLoopRuns(words, opts)
  if (runs.length === 0) return words
  const drop = new Uint8Array(words.length)
  for (const run of runs) for (let k = run.start + run.gram; k < run.end; k++) drop[k] = 1
  return words.filter((_, i) => !drop[i])
}
