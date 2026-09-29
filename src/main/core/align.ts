// Finds where a downloaded clip actually starts by matching its audio against
// the full stream audio. Section downloads can start a little before or after
// the requested time (keyframes, segment boundaries); captions must not drift.

/** Loudness envelope: RMS of fixed frames (default 10 ms). */
export function envelope(pcm: Float32Array, rate: number, frameSec = 0.01): Float32Array {
  const frame = Math.max(1, Math.round(rate * frameSec))
  const n = Math.floor(pcm.length / frame)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    let s = 0
    for (let j = i * frame; j < (i + 1) * frame; j++) s += pcm[j]! * pcm[j]!
    out[i] = Math.sqrt(s / frame)
  }
  return out
}

/**
 * Finds the offset (in frames) where `probe` best matches inside `ref`, using
 * normalised cross-correlation. score is -1..1; above ~0.6 is a confident match.
 */
export function bestLag(ref: Float32Array, probe: Float32Array): { lag: number; score: number } {
  const m = probe.length
  if (m === 0 || ref.length < m) return { lag: 0, score: 0 }
  let pMean = 0
  for (let i = 0; i < m; i++) pMean += probe[i]!
  pMean /= m
  let pVar = 0
  const p = new Float32Array(m)
  for (let i = 0; i < m; i++) {
    p[i] = probe[i]! - pMean
    pVar += p[i]! * p[i]!
  }
  if (pVar === 0) return { lag: 0, score: 0 }

  let best = { lag: 0, score: -Infinity }
  // Sliding sums keep the window mean/variance O(1) per lag.
  let sum = 0
  let sumSq = 0
  for (let i = 0; i < m; i++) {
    sum += ref[i]!
    sumSq += ref[i]! * ref[i]!
  }
  for (let lag = 0; lag + m <= ref.length; lag++) {
    if (lag > 0) {
      const out = ref[lag - 1]!
      const inn = ref[lag + m - 1]!
      sum += inn - out
      sumSq += inn * inn - out * out
    }
    const mean = sum / m
    const varR = sumSq - m * mean * mean
    if (varR <= 1e-12) continue
    let dot = 0
    for (let i = 0; i < m; i++) dot += p[i]! * ref[lag + i]!
    const score = dot / Math.sqrt(pVar * varR)
    if (score > best.score) best = { lag, score }
  }
  return best.score === -Infinity ? { lag: 0, score: 0 } : best
}

/** Converts little-endian signed 16-bit PCM bytes to floats. */
export function pcm16ToFloat(buf: Buffer): Float32Array {
  const n = Math.floor(buf.length / 2)
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) out[i] = buf.readInt16LE(i * 2) / 32768
  return out
}

export interface EnergySpan {
  t0: number
  t1: number
}

/**
 * Finds where the voice actually is inside [spanStart, spanEnd) of a fine
 * loudness envelope (see `envelope`), for a whisper word whose timing
 * stretched across a silence. Short dips below the noise floor (a stop
 * consonant, a breath) are bridged so one word is not split in two. Returns
 * null when the span holds no clear speech above its own surroundings, so
 * the caller can fall back to the text heuristic.
 */
export function locateWordEnergy(env: Float32Array, frameSec: number, spanStart: number, spanEnd: number, bridgeSec = 0.12): EnergySpan | null {
  const i0 = Math.max(0, Math.floor(spanStart / frameSec))
  const i1 = Math.min(env.length, Math.ceil(spanEnd / frameSec))
  const n = i1 - i0
  if (n < 1) return null
  const frames = env.subarray(i0, i1)

  const sorted = Float32Array.from(frames).sort()
  const floor = sorted[Math.floor(sorted.length * 0.25)] ?? 0
  const threshold = Math.max(floor * 2, floor + 1e-4)
  const bridgeFrames = Math.max(1, Math.round(bridgeSec / frameSec))

  const active = new Uint8Array(n)
  for (let i = 0; i < n; i++) active[i] = frames[i]! > threshold ? 1 : 0
  // Bridge short silent gaps that sit between two active stretches.
  let i = 0
  while (i < n) {
    if (active[i]) {
      i++
      continue
    }
    let j = i
    while (j < n && !active[j]) j++
    if (i > 0 && j < n && j - i <= bridgeFrames) for (let k = i; k < j; k++) active[k] = 1
    i = j
  }

  // The loudest contiguous active run is the real word.
  let bestStart = -1
  let bestEnd = -1
  let bestSum = -Infinity
  i = 0
  while (i < n) {
    if (!active[i]) {
      i++
      continue
    }
    let j = i
    let sum = 0
    while (j < n && active[j]) {
      sum += frames[j]!
      j++
    }
    if (sum > bestSum) {
      bestSum = sum
      bestStart = i
      bestEnd = j
    }
    i = j
  }
  if (bestStart < 0) return null
  return { t0: spanStart + bestStart * frameSec, t1: spanStart + bestEnd * frameSec }
}
