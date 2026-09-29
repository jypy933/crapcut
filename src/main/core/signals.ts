// Time-series signals used to find moments: chat activity and audio loudness,
// sampled once per second, turned into robust "how unusual is this" scores.

import type { ChatMessage } from './chat'

/** One value per second, index = second from the start of the VOD. */
export type Series = Float64Array

const LAUGH =
  /\b(kekw|kekl|lul|lulw|omegalul|lmao+|lmfao|lol+|icant|pepelaugh|xd+|mdr+|ptdr+|jaja+|haha+|hehe+|dead|💀)\b|😂|🤣|💀/i
const HYPE =
  /\b(pog\w*|poggers|pogchamp|w{1,}|l{1,}|clip( ?it| ?that)?|!clip|holy|no ?way|omg|lets ?go+|let'?s go+|gg+|ez|insane|clutch|hype)\b/i
const SHOCK = /^\?+$|\bwtf\b|\bmonka\w*|\bd:|\bno+o+\b|\bwhat\b|😱|😳/i

/** How strong a reaction one chat message is (1..3). */
export function reactionWeight(text: string): number {
  let w = 1
  if (LAUGH.test(text)) w += 1
  if (HYPE.test(text)) w += 1
  if (SHOCK.test(text)) w += 0.5
  const letters = text.replace(/[^a-zA-Z]/g, '')
  if (letters.length >= 4 && letters === letters.toUpperCase()) w += 0.3
  return Math.min(w, 3)
}

/** Seconds a rolling window looks around each second to count distinct chatters. */
const CHATTER_WINDOW_SEC = 20

/**
 * How much distinct-chatter reaction is happening around each second: each
 * chatter is counted at most once per rolling `windowSec` window, weighted by
 * their single strongest reaction in it. This counts people, not messages, so
 * one chatter posting several times cannot fake a crowd, and a handful of
 * different regulars reacting together stands out even in a small, slow
 * chat. Because it is turned into a z-score against this stream's own
 * rolling baseline (see `robustZ`), it scales to a large, fast chat too: the
 * same handful of people means nothing there, and only an unusually wide
 * burst of different chatters registers.
 */
export function chatterBurstSeries(messages: ChatMessage[], durationSec: number, windowSec = CHATTER_WINDOW_SEC): Series {
  const n = Math.max(1, Math.ceil(durationSec))
  const out = new Float64Array(n)
  const events = messages
    .filter((m) => m.t >= 0 && m.t < n)
    .map((m) => ({ t: m.t, user: m.user.toLowerCase(), w: reactionWeight(m.text) }))
    .sort((a, b) => a.t - b.t)
  if (events.length === 0) return out

  const half = windowSec / 2
  const activeByUser = new Map<string, number[]>()
  const maxOf = (list: number[]): number => list.reduce((m, w) => Math.max(m, w), 0)
  let sum = 0
  let lo = 0
  let hi = 0
  for (let t = 0; t < n; t++) {
    while (hi < events.length && events[hi]!.t <= t + half) {
      const e = events[hi]!
      const list = activeByUser.get(e.user) ?? []
      const before = maxOf(list)
      list.push(e.w)
      activeByUser.set(e.user, list)
      sum += maxOf(list) - before
      hi++
    }
    while (lo < events.length && events[lo]!.t < t - half) {
      const e = events[lo]!
      const list = activeByUser.get(e.user)
      if (list) {
        const before = maxOf(list)
        list.shift()
        if (list.length === 0) activeByUser.delete(e.user)
        sum += maxOf(list) - before
      }
      lo++
    }
    out[t] = sum
  }
  return out
}

/** Distinct chatters (unweighted) with a message in [from, to]. */
export function distinctChatters(messages: ChatMessage[], from: number, to: number): number {
  const set = new Set<string>()
  for (const m of messages) {
    if (m.t < from) continue
    if (m.t > to) break
    set.add(m.user.toLowerCase())
  }
  return set.size
}

/** Centred moving average over `window` seconds. */
export function movingAverage(values: Series, window: number): Series {
  const n = values.length
  const out = new Float64Array(n)
  const half = Math.max(0, Math.floor(window / 2))
  let sum = 0
  let lo = 0
  let hi = -1
  for (let i = 0; i < n; i++) {
    const a = Math.max(0, i - half)
    const b = Math.min(n - 1, i + half)
    while (hi < b) sum += values[++hi]!
    while (lo < a) sum -= values[lo++]!
    out[i] = sum / (b - a + 1)
  }
  return out
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * Rolling median and median absolute deviation over a long window, computed on
 * coarse buckets (fast enough for 12 h streams) and interpolated back per second.
 */
export function rollingBaseline(
  values: Series,
  windowSec = 600,
  bucketSec = 10
): { median: Series; mad: Series } {
  const n = values.length
  const buckets = Math.max(1, Math.ceil(n / bucketSec))
  const bucketMean = new Float64Array(buckets)
  for (let b = 0; b < buckets; b++) {
    let s = 0
    let c = 0
    for (let i = b * bucketSec; i < Math.min(n, (b + 1) * bucketSec); i++) {
      s += values[i]!
      c++
    }
    bucketMean[b] = c ? s / c : 0
  }
  const halfB = Math.max(1, Math.round(windowSec / bucketSec / 2))
  const bMed = new Float64Array(buckets)
  const bMad = new Float64Array(buckets)
  for (let b = 0; b < buckets; b++) {
    const win: number[] = []
    for (let j = Math.max(0, b - halfB); j <= Math.min(buckets - 1, b + halfB); j++) win.push(bucketMean[j]!)
    win.sort((x, y) => x - y)
    const med = median(win)
    const dev = win.map((v) => Math.abs(v - med)).sort((x, y) => x - y)
    bMed[b] = med
    bMad[b] = median(dev)
  }
  const med = new Float64Array(n)
  const mad = new Float64Array(n)
  for (let i = 0; i < n; i++) {
    const pos = i / bucketSec - 0.5
    const b0 = Math.max(0, Math.min(buckets - 1, Math.floor(pos)))
    const b1 = Math.min(buckets - 1, b0 + 1)
    const f = Math.max(0, Math.min(1, pos - b0))
    med[i] = bMed[b0]! * (1 - f) + bMed[b1]! * f
    mad[i] = bMad[b0]! * (1 - f) + bMad[b1]! * f
  }
  return { median: med, mad }
}

/**
 * Robust z-score: how many "typical deviations" above the local normal each
 * second is. `floor` keeps quiet streams from turning noise into spikes.
 */
export function robustZ(values: Series, windowSec = 600, floor = 0.5): Series {
  const { median: med, mad } = rollingBaseline(values, windowSec)
  const out = new Float64Array(values.length)
  for (let i = 0; i < values.length; i++) {
    const scale = Math.max(1.4826 * mad[i]!, 0.25 * med[i]!, floor)
    out[i] = (values[i]! - med[i]!) / scale
  }
  return out
}

export interface Peak {
  /** Second of the maximum. */
  t: number
  /** z-score at the maximum. */
  z: number
  /** Second where the rise started. */
  onset: number
}

/**
 * Local maxima above `minZ`, strongest first, at least `separation` seconds
 * apart. The onset is where the score first climbed above `onsetZ`.
 */
export function findPeaks(z: Series, minZ: number, separation: number, onsetZ = 1, maxRise = 60): Peak[] {
  const candidates: number[] = []
  for (let i = 0; i < z.length; i++) {
    const v = z[i]!
    if (v < minZ) continue
    if ((i === 0 || v >= z[i - 1]!) && (i === z.length - 1 || v > z[i + 1]!)) candidates.push(i)
  }
  candidates.sort((a, b) => z[b]! - z[a]!)
  const picked: Peak[] = []
  for (const t of candidates) {
    if (picked.some((p) => Math.abs(p.t - t) < separation)) continue
    let onset = t
    while (onset > 0 && t - onset < maxRise && z[onset - 1]! > onsetZ) onset--
    picked.push({ t, z: z[t]!, onset })
  }
  return picked
}

/** Largest value of `s` in [from, to] (clamped). */
export function maxIn(s: Series, from: number, to: number): number {
  let m = -Infinity
  for (let i = Math.max(0, Math.floor(from)); i <= Math.min(s.length - 1, Math.ceil(to)); i++) m = Math.max(m, s[i]!)
  return m === -Infinity ? 0 : m
}
