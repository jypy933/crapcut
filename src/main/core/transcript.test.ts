import { describe, expect, it } from 'vitest'
import { mergeChunks, packWords, parseVadSpans, parseWhisperJson, placeChunkWords, planChunks, repairChunkWordTimings, unpackWords, vadToOriginal, wordsIn } from './transcript'

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
    expect(parseWhisperJson(null)).toEqual({ language: null, words: [], dtw: false })
  })

  it('cuts hallucinated loops but keeps short repeats', () => {
    const loop = Array.from({ length: 10 }, (_, i) => seg(i * 100, i * 100 + 90, ' thanks'))
    expect(parseWhisperJson({ transcription: loop }).words).toHaveLength(2)
    const shortRun = Array.from({ length: 3 }, (_, i) => seg(i * 100, i * 100 + 90, ' no'))
    expect(parseWhisperJson({ transcription: shortRun }).words).toHaveLength(3)
  })
})

describe('parseVadSpans', () => {
  it('reads the stretches whisper.cpp logs, in speech-audio order', () => {
    const spans = parseVadSpans([
      'whisper_vad: vad_segment_info: orig_start: 8.64, orig_end: 12.19, vad_start: 3.09, vad_end: 6.64',
      'whisper_vad: total duration of speech segments: 26.40 seconds',
      'whisper_vad: vad_segment_info: orig_start: 2.40, orig_end: 2.81, vad_start: 0.00, vad_end: 0.41',
      'whisper_vad: vad_segment_info: orig_start: x, orig_end: 1, vad_start: 0, vad_end: 1'
    ])
    expect(spans).toEqual([
      { start: 2.4, end: 2.81, vadStart: 0 },
      { start: 8.64, end: 12.19, vadStart: 3.09 }
    ])
  })
})

describe('vadToOriginal', () => {
  const spans = [
    { start: 2.4, end: 2.81, vadStart: 0 },
    { start: 8.64, end: 12.19, vadStart: 0.61 }
  ]

  it('moves a speech-audio time into the stretch it falls in', () => {
    expect(vadToOriginal(0.1, spans)!.t).toBeCloseTo(2.5)
    expect(vadToOriginal(1.61, spans)!.t).toBeCloseTo(9.64)
    expect(vadToOriginal(1.61, spans)!.span).toBe(spans[1])
  })

  it('keeps a time in the gap between stretches at the end of the earlier one', () => {
    expect(vadToOriginal(0.55, spans)!.t).toBeCloseTo(2.91)
    expect(vadToOriginal(1, [])).toBeNull()
  })
})

describe('parseWhisperJson with DTW word times', () => {
  // One word per segment (-ml 1), DTW times in 10 ms units (-ojf -dtw).
  const seg = (from: number, to: number, text: string, dtw: number) => ({
    offsets: { from, to },
    text,
    tokens: [
      { text: '[_BEG_]', t_dtw: -1 },
      { text, t_dtw: dtw }
    ]
  })

  it('starts words at their DTW time less the lag, and ends them before a pause', () => {
    // Whisper's own timestamps rush "am" and "done" ahead of the voice.
    const r = parseWhisperJson({ transcription: [seg(0, 300, ' I', 30), seg(300, 1500, ' am', 90), seg(1500, 1800, ' done.', 300)] }, { vad: null })
    expect(r.dtw).toBe(true)
    expect(r.words.map((w) => w.t0)).toEqual([0.1, 0.7, 2.8])
    expect(r.words[0]!.t1).toBeCloseTo(0.32) // capped at a plausible length for "I"
    expect(r.words[1]!.t1).toBeCloseTo(0.94) // not stretched across the pause
    expect(r.words[2]!.t1).toBeCloseTo(3.28)
  })

  it('maps DTW times through the VAD stretches and keeps words inside them', () => {
    const vad = [
      { start: 5, end: 5.5, vadStart: 0 },
      { start: 9, end: 10, vadStart: 0.7 }
    ]
    const r = parseWhisperJson({ transcription: [seg(5000, 5300, ' hey', 25), seg(9000, 9400, ' you', 72), seg(9400, 9900, ' there', 110)] }, { vad })
    expect(r.dtw).toBe(true)
    // "you": DTW 0.72 -> 9.02 in the file, less the lag would be before its stretch.
    expect(r.words.map((w) => +w.t0.toFixed(2))).toEqual([5.05, 9, 9.2])
    expect(r.words[2]!.t1).toBeCloseTo(9.8)
    expect(r.words[0]!.t1).toBeLessThanOrEqual(5.6)
  })

  it('keeps word order when DTW times go backwards', () => {
    const r = parseWhisperJson({ transcription: [seg(0, 200, ' one', 60), seg(200, 400, ' two', 50)] }, { vad: null })
    expect(r.words.map((w) => w.text)).toEqual(['one', 'two'])
    expect(r.words[1]!.t0).toBeGreaterThanOrEqual(r.words[0]!.t0)
  })

  it('joins word pieces and keeps the first piece start', () => {
    const r = parseWhisperJson({ transcription: [seg(0, 200, ' don', 40), seg(200, 400, "'t", 55), seg(400, 600, ' go', 70)] }, { vad: null })
    expect(r.words.map((w) => [w.text, +w.t0.toFixed(2)])).toEqual([
      ["don't", 0.2],
      ['go', 0.5]
    ])
  })

  it('falls back to whisper timestamps when DTW is missing or cannot be mapped', () => {
    const missing = parseWhisperJson({ transcription: [seg(0, 200, ' a', 10), seg(200, 400, ' b', -1)] }, { vad: null })
    expect(missing.dtw).toBe(false)
    expect(missing.words.map((w) => w.t0)).toEqual([0, 0.2])
    // VAD was on but its log lines could not be read: DTW times are in the wrong clock.
    expect(parseWhisperJson({ transcription: [seg(0, 200, ' a', 10)] }, { vad: [] }).dtw).toBe(false)
    // Plain -oj output and callers that do not ask for DTW.
    expect(parseWhisperJson({ transcription: [{ offsets: { from: 0, to: 200 }, text: ' a' }] }, { vad: null }).dtw).toBe(false)
    expect(parseWhisperJson({ transcription: [seg(0, 200, ' a', 10)] }).dtw).toBe(false)
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
