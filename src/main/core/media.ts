// Parsers for small text outputs: HLS playlists (muted segments) and FFmpeg's
// per-second loudness log.

import type { Range } from '@shared/types'

/**
 * Twitch replaces copyrighted audio with silence and names those HLS segments
 * "<n>-muted.ts" / "<n>-muted.mp4". Returns the muted time ranges, merged.
 */
export function parseMutedSegments(playlist: string): Range[] {
  const ranges: Range[] = []
  let t = 0
  let pending: number | null = null
  for (const raw of playlist.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('#EXTINF:')) {
      const d = Number.parseFloat(line.slice(8))
      pending = Number.isFinite(d) && d > 0 ? d : 0
      continue
    }
    if (!line || line.startsWith('#')) continue
    if (pending === null) continue
    if (/-muted\.[a-z0-9]+(\?|$)/i.test(line)) {
      const last = ranges[ranges.length - 1]
      if (last && Math.abs(last.end - t) < 1e-6) last.end = t + pending
      else ranges.push({ start: t, end: t + pending })
    }
    t += pending
    pending = null
  }
  return ranges.map((r) => ({ start: round3(r.start), end: round3(r.end) }))
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

/**
 * Parses the output of FFmpeg `ametadata=mode=print` for astats RMS_level with
 * one-second frames. Silence ("-inf") becomes -120 dB.
 */
export function parseLoudnessLog(text: string, durationSec: number): Float64Array {
  const n = Math.max(1, Math.ceil(durationSec))
  const out = new Float64Array(n).fill(-120)
  let current: number | null = null
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    const frame = /pts_time:([\d.]+)/.exec(line)
    if (frame) {
      current = Math.floor(Number(frame[1]))
      continue
    }
    const val = /RMS_level=(-?inf|-?[\d.]+)/i.exec(line)
    if (val && current !== null && current >= 0 && current < n) {
      const v = val[1]!.toLowerCase().includes('inf') ? -120 : Number(val[1])
      out[current] = Number.isFinite(v) ? Math.max(-120, v) : -120
    }
  }
  return out
}

/** Merges overlapping or touching ranges. */
export function mergeRanges(ranges: Range[], gap = 0): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start)
  const out: Range[] = []
  for (const r of sorted) {
    const last = out[out.length - 1]
    if (last && r.start <= last.end + gap) last.end = Math.max(last.end, r.end)
    else out.push({ ...r })
  }
  return out
}

/** Seconds of `r` covered by `ranges`. */
export function overlapSeconds(r: Range, ranges: Range[]): number {
  let s = 0
  for (const m of ranges) s += Math.max(0, Math.min(r.end, m.end) - Math.max(r.start, m.start))
  return s
}
