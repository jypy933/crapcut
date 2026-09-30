// Which caption word gets the calm key-word emphasis (a soft accent colour and
// a small size bump, see `emphasis*` in captionStyles.ts). Pure text-and-timing
// logic shared by the review preview (renderer) and the ASS burn-in (main), so
// both emphasise the same words. Research says highlights help but heavy
// emphasis distracts in casual viewing (docs/auto-edit-research.md), so it is
// rare: one word per caption group at most, never a filler word, and no more
// often than every couple of seconds.

import { isKeywordWord, type CaptionGroup } from './captions'

/** Emphasised words start at least this far apart (seconds). */
export const MIN_EMPHASIS_GAP_SEC = 2

/** A word needs at least this score to be emphasised at all. */
export const MIN_EMPHASIS_SCORE = 2

/** Score for `isKeywordWord`: shouted, a number, or ending in "!". */
export const KEYWORD_SCORE = 3
/** Score for a substantial (long) word. */
export const LONG_WORD_SCORE = 1
/** A word this long (letters) counts as substantial. */
export const LONG_WORD_LETTERS = 6
/** Score for the word that ends a sentence (the punchline). */
export const SENTENCE_END_SCORE = 1

/** Small words and spoken filler that never get emphasis, even when shouted. */
const NEVER_EMPHASISED = new Set(
  (
    'a an the and or but so if then than that this these those to of in on at by for with from as is are was were be been am ' +
    'it its i im ive ill id you your youre we our they them he she his her me my do does did dont doesnt didnt not no yes ' +
    'um uh uhh umm er erm hmm mm mhm ah oh ok okay yeah yep yup nah like just really literally actually basically kinda sorta ' +
    'well right anyway alright gonna wanna gotta lol lmao'
  ).split(' ')
)

/** The word as letters and digits only, lower case ("It's!" -> "its"). */
function core(text: string): string {
  return text.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, '')
}

/** How strongly a word wants emphasis; 0 for filler and empty words. */
export function emphasisScore(text: string): number {
  const c = core(text)
  if (!c || NEVER_EMPHASISED.has(c)) return 0
  let score = 0
  if (isKeywordWord(text)) score += KEYWORD_SCORE
  if (c.length >= LONG_WORD_LETTERS) score += LONG_WORD_SCORE
  if (/[.!?…]["')\]]*$/.test(text.trim())) score += SENTENCE_END_SCORE
  return score
}

export interface EmphasisOptions {
  minScore: number
  minGapSec: number
}

export const DEFAULT_EMPHASIS: EmphasisOptions = { minScore: MIN_EMPHASIS_SCORE, minGapSec: MIN_EMPHASIS_GAP_SEC }

/**
 * For each group, the index of its emphasised word, or -1. Depends only on the
 * words, so an edited caption text simply moves the emphasis with the words.
 */
export function pickEmphasis(groups: CaptionGroup[], opts: EmphasisOptions = DEFAULT_EMPHASIS): number[] {
  const picks = groups.map(() => -1)
  const kept: { g: number; i: number; t0: number; score: number }[] = []
  for (let g = 0; g < groups.length; g++) {
    const words = groups[g]!.words
    let best = -1
    let bestScore = 0
    for (let i = 0; i < words.length; i++) {
      const s = emphasisScore(words[i]!.text)
      // On a tie the later word wins: the punchline comes last.
      if (s >= opts.minScore && s >= bestScore) {
        best = i
        bestScore = s
      }
    }
    if (best < 0) continue
    const cand = { g, i: best, t0: words[best]!.t0, score: bestScore }
    const last = kept[kept.length - 1]
    if (!last || cand.t0 - last.t0 >= opts.minGapSec) {
      kept.push(cand)
      continue
    }
    // Too close to the previous one: only a clearly stronger word takes its place.
    const before = kept[kept.length - 2]
    if (cand.score > last.score && (!before || cand.t0 - before.t0 >= opts.minGapSec)) kept[kept.length - 1] = cand
  }
  for (const k of kept) picks[k.g] = k.i
  return picks
}
