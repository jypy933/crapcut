import { describe, expect, it } from 'vitest'
import { bestLag, envelope, locateWordEnergy, pcm16ToFloat } from './align'

/** A 10 ms-frame envelope: mostly a quiet floor, loud during the given [start, end) frame ranges. */
function fakeEnvelope(frames: number, loudRanges: [number, number][], floor = 0.01, loud = 0.5): Float32Array {
  const out = new Float32Array(frames).fill(floor)
  for (const [a, b] of loudRanges) for (let i = a; i < b && i < frames; i++) out[i] = loud
  return out
}

function noiseBursts(seconds: number, rate: number, seed = 3): Float32Array {
  let s = seed
  const r = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff
    return s / 0x7fffffff
  }
  const out = new Float32Array(seconds * rate)
  let amp = 0.1
  for (let i = 0; i < out.length; i++) {
    if (i % Math.round(rate * 0.05) === 0) amp = r() < 0.3 ? 0.8 * r() : 0.05 * r()
    out[i] = amp * (r() * 2 - 1)
  }
  return out
}

describe('align', () => {
  const rate = 8000
  const full = noiseBursts(60, rate)

  it('finds a clip inside the full audio to within one frame', () => {
    const trueStart = 17.37
    const clip = full.slice(Math.round(trueStart * rate), Math.round((trueStart + 20) * rate))
    // Search a window starting 10 s before where we expected the clip.
    const expected = 17.8
    const refStart = expected - 10
    const ref = envelope(full.slice(Math.round(refStart * rate), Math.round((refStart + 40) * rate)), rate)
    const { lag, score } = bestLag(ref, envelope(clip, rate))
    expect(score).toBeGreaterThan(0.9)
    expect(refStart + lag * 0.01).toBeCloseTo(trueStart, 1)
    expect(Math.abs(refStart + lag * 0.01 - trueStart)).toBeLessThanOrEqual(0.011)
  })

  it('reports low confidence for silence or unrelated audio', () => {
    const silent = new Float32Array(rate * 5)
    expect(bestLag(envelope(full.slice(0, rate * 30), rate), envelope(silent, rate)).score).toBe(0)
    const other = noiseBursts(10, rate, 99)
    expect(bestLag(envelope(full.slice(0, rate * 30), rate), envelope(other, rate)).score).toBeLessThan(0.5)
  })

  it('handles degenerate inputs', () => {
    expect(bestLag(new Float32Array(3), new Float32Array(10))).toEqual({ lag: 0, score: 0 })
    expect(bestLag(new Float32Array(10), new Float32Array(0))).toEqual({ lag: 0, score: 0 })
  })

  it('decodes 16-bit PCM', () => {
    const b = Buffer.alloc(4)
    b.writeInt16LE(16384, 0)
    b.writeInt16LE(-32768, 2)
    expect(Array.from(pcm16ToFloat(b))).toEqual([0.5, -1])
  })
})

describe('locateWordEnergy', () => {
  const frameSec = 0.01

  it('finds a short burst of speech inside a much wider silent span', () => {
    // A word really spoken at 0.30-0.40 s, but whisper stretched it 0-0.80 s.
    const env = fakeEnvelope(100, [[30, 40]])
    const found = locateWordEnergy(env, frameSec, 0, 0.8)
    expect(found).not.toBeNull()
    expect(found!.t0).toBeCloseTo(0.3, 2)
    expect(found!.t1).toBeCloseTo(0.4, 2)
  })

  it('bridges a short dip inside one word (a stop consonant or a breath)', () => {
    // Two loud stretches 2 frames apart (20 ms), well under the bridge.
    const env = fakeEnvelope(100, [
      [30, 40],
      [42, 50]
    ])
    const found = locateWordEnergy(env, frameSec, 0, 0.8, 0.12)
    expect(found!.t0).toBeCloseTo(0.3, 2)
    expect(found!.t1).toBeCloseTo(0.5, 2)
  })

  it('does not bridge a real gap between two separate words', () => {
    // Two loud stretches far apart: picks the louder/longer one, not both.
    const env = fakeEnvelope(100, [
      [10, 15],
      [60, 80]
    ])
    const found = locateWordEnergy(env, frameSec, 0, 1.0, 0.12)
    expect(found!.t0).toBeCloseTo(0.6, 2)
    expect(found!.t1).toBeCloseTo(0.8, 2)
  })

  it('returns null for a span with no clear speech', () => {
    const env = fakeEnvelope(100, [])
    expect(locateWordEnergy(env, frameSec, 0, 0.8)).toBeNull()
  })

  it('returns null for a degenerate (empty) span', () => {
    const env = fakeEnvelope(100, [[30, 40]])
    expect(locateWordEnergy(env, frameSec, 0.5, 0.5)).toBeNull()
  })
})
