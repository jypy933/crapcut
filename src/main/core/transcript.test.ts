import { describe, expect, it } from 'vitest'
import { mergeChunks, packWords, parseWhisperJson, placeChunkWords, planChunks, repairChunkWordTimings, unpackWords, wordsIn } from './transcript'

/** A 10 ms-frame envelope: mostly a quiet floor, loud during the given [start, end) frame ranges. */
function fakeEnvelope(frames: number, loudRanges: [number, number][], floor = 0.01, loud = 0.5): Float32Array {
  const out = new Float32Array(frames).fill(floor)
  for (const [a, b] of loudRanges) for (let i = a; i < b && i < frames; i++) out[i] = loud
  return out
}

describe('planChunks', () => {
  it('covers the whole duration without gaps', () => {
    const chunks = planChunks(3600, null, 600)
    expect(chunks[0]!.start).toBe(0)
    expect(chunks[chunks.length - 1]!.end).toBe(3600)
    for (let i = 1; i < chunks.length; i++) expect(chunks[i]!.start).toBe(chunks[i - 1]!.end)
    expect(chunks).toHaveLength(6)
  })

  it('moves cuts to the quietest second nearby', () => {
    const loud = new Float64Array(1300).fill(-20)
    loud[611] = -80
    const chunks = planChunks(1300, loud, 600, 30)
    expect(chunks[0]!.end).toBe(611)
  })

  it('does not leave a tiny last chunk', () => {
    const chunks = planChunks(1250, null, 600)
    expect(chunks.map((c) => c.end)).toEqual([600, 1250])
  })

  it('handles short audio', () => {
    expect(planChunks(42, null)).toEqual([{ start: 0, end: 42 }])
    expect(planChunks(0, null)).toEqual([])
  })
})

describe('parseWhisperJson', () => {
  const seg = (from: number, to: number, text: string) => ({ offsets: { from, to }, text })

  it('reads words, language and drops non-speech', () => {
    const r = parseWhisperJson({
      result: { language: 'fr' },
      transcription: [seg(1000, 1100, ''), seg(1000, 1300, ' Salut'), seg(1300, 1600, ' [BLANK_AUDIO]'), seg(1600, 2000, ' toi.')]
    })
    expect(r.language).toBe('fr')
    expect(r.words).toEqual([
      { t0: 1, t1: 1.3, text: 'Salut' },
      { t0: 1.6, t1: 2, text: 'toi.' }
    ])
  })

  it('drops speaker dashes and bare punctuation', () => {
    const r = parseWhisperJson({ transcription: [seg(0, 100, ' -'), seg(100, 300, ' - You'), seg(300, 500, ' ...'), seg(500, 700, ' go')] })
    expect(r.words.map((w) => w.text)).toEqual(['You', 'go'])
  })

  it('joins word pieces without a leading space', () => {
    const r = parseWhisperJson({ transcription: [seg(0, 200, ' don'), seg(200, 400, "'t"), seg(400, 600, ' go')] })
    expect(r.words.map((w) => w.text)).toEqual(["don't", 'go'])
  })

  it('fixes overlaps and survives junk', () => {
    const r = parseWhisperJson({ transcription: [seg(0, 500, ' a'), seg(300, 600, ' b'), { text: ' c' }, 'x', null] })
    expect(r.words).toEqual([
      { t0: 0, t1: 0.3, text: 'a' },
      { t0: 0.3, t1: 0.6, text: 'b' }
    ])
    expect(parseWhisperJson(null)).toEqual({ language: null, words: [] })
  })

  it('cuts hallucinated loops but keeps short repeats', () => {
    const loop = Array.from({ length: 10 }, (_, i) => seg(i * 100, i * 100 + 90, ' thanks'))
    expect(parseWhisperJson({ transcription: loop }).words).toHaveLength(2)
    const shortRun = Array.from({ length: 3 }, (_, i) => seg(i * 100, i * 100 + 90, ' no'))
    expect(parseWhisperJson({ transcription: shortRun }).words).toHaveLength(3)
  })
})

describe('word helpers', () => {
  const words = [0, 1, 2, 3, 4].map((i) => ({ t0: i, t1: i + 0.8, text: `w${i}` }))
  it('finds words in a range', () => {
    expect(wordsIn(words, 1.5, 3.2).map((w) => w.text)).toEqual(['w1', 'w2', 'w3'])
    expect(wordsIn(words, 10, 20)).toEqual([])
  })
  it('merges chunks keeping each word once', () => {
    const merged = mergeChunks([
      { range: { start: 0, end: 2.5 }, words: words.slice(0, 4) },
      { range: { start: 2.5, end: 5 }, words: words.slice(2) }
    ])
    expect(merged.map((w) => w.text)).toEqual(['w0', 'w1', 'w2', 'w3', 'w4'])
  })
  it('packs and unpacks', () => {
    expect(unpackWords(packWords(words))).toEqual(words)
  })
})

describe('placeChunkWords', () => {
  const range = { start: 1200, end: 1800 }

  it('moves chunk-relative times onto the VOD timeline', () => {
    const r = placeChunkWords([{ t0: 0.5, t1: 0.9, text: 'hi' }, { t0: 599, t1: 599.4, text: 'bye' }], range)
    expect(r.words).toEqual([{ t0: 1200.5, t1: 1200.9, text: 'hi' }, { t0: 1799, t1: 1799.4, text: 'bye' }])
    expect(r.dropped).toBe(0)
  })

  it('drops words timed outside the chunk', () => {
    const r = placeChunkWords([{ t0: 10, t1: 11, text: 'ok' }, { t0: 2768, t1: 2769, text: 'lost' }], range)
    expect(r.words.map((w) => w.text)).toEqual(['ok'])
    expect(r.dropped).toBe(1)
  })

  it('keeps a word that runs just past the end, clipped', () => {
    const r = placeChunkWords([{ t0: 599.8, t1: 603, text: 'end' }], range)
    expect(r.words[0]!.t1).toBe(1801)
  })
})

describe('repairChunkWordTimings', () => {
  const frameSec = 0.01

  it('places a stretched word on the real speech found in the envelope', () => {
    // "mind" really spoken at 3.98-4.20 s, but whisper stretched it 0.71-11.93 s.
    const env = fakeEnvelope(1300, [[398, 420]])
    const words = [{ t0: 0.71, t1: 11.93, text: 'Mind' }]
    const fixed = repairChunkWordTimings(words, env, frameSec)
    expect(fixed[0]!.t0).toBeCloseTo(3.98, 2)
    expect(fixed[0]!.t1).toBeCloseTo(4.2, 2)
  })

  it('leaves plausible words alone', () => {
    const env = fakeEnvelope(200, [[10, 20]])
    const words = [{ t0: 0.1, t1: 0.2, text: 'hi' }]
    expect(repairChunkWordTimings(words, env, frameSec)).toEqual(words)
  })

  it('leaves a word alone when its span has no clear speech', () => {
    const env = fakeEnvelope(1300, [])
    const words = [{ t0: 0.71, t1: 11.93, text: 'Mind' }]
    expect(repairChunkWordTimings(words, env, frameSec)).toEqual(words)
  })

  it('leaves a word alone when the match found is implausibly wide', () => {
    // The whole span looks loud (maybe two words' worth): do not trust it.
    const env = fakeEnvelope(1300, [[0, 1200]])
    const words = [{ t0: 0.71, t1: 11.93, text: 'Mind' }]
    expect(repairChunkWordTimings(words, env, frameSec)).toEqual(words)
  })
})
