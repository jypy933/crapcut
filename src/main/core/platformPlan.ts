// What one clip version becomes on one platform: the version's edit, held to
// the platform's length cap, its loop kept only when that version's seam
// passed, its on-screen overlays kept inside the platform's safe zone. Pure
// (the words and the edit come in, a plan comes out); rendering it is
// `pipeline/clipRender.ts`, the rule engine that made the versions is
// `editPlan.ts`, and the rules' numbers are in `editRules.ts` (caps) and
// `shared/captionSafeZone.ts` (zones).
//
// A version longer than a cap is never chopped mid-sentence. It is cut at a
// phrase boundary just under the cap when that costs only a few seconds and
// leaves the payoff and its reaction beat in; otherwise the platform is
// skipped for that clip with one plain note. Cutting a long clip down further
// would change the clip, and the streamer can shorten it in Review himself.

import type { SafeZone } from '@shared/captionSafeZone'
import type { ClipEditPlan, Platform } from '@shared/editPlan'
import { PLATFORM_LABELS, type ClipVersion } from '@shared/platformExport'
import type { Word } from '@shared/types'
import { EDIT_RULES } from './editRules'
import { concatDuration, outputDuration, segmentDuration, segmentStarts, sourceToOutputTime, type Edl, type EdlSegment, type OverlayCue } from './edl'
import { remapWordsToEdl } from './edlCaptions'

export const PLATFORM_RULES = {
  /** The most a version may lose off its end to fit a cap; more than this and the platform is skipped instead. */
  maxTrimSec: 8,
  /** A trimmed version ends this long after the last kept word's real end (word ends sit early, see `EDIT_RULES.loop.wordEndEarlySec`). */
  cutTailSec: 0.2,
  /** A word ends a phrase when the next one starts this much later (or it ends a sentence). */
  phraseGapSec: 0.25,
  /** Half the height of an overlay's text box, pixels: it is anchored on its middle, so this much must fit above and below. */
  overlayHalfHeightPx: 60
} as const

const EPS = 1e-6

/** The edit chosen for a clip: the wanted version, or the straight edit when the cold open is not there (any more). */
export function pickVersion(planned: { edl: Edl; coldOpenEdl: Edl | null; plan: ClipEditPlan }, wanted: ClipVersion | undefined): { version: ClipVersion; edl: Edl } {
  if (wanted === 'coldOpen' && planned.coldOpenEdl) return { version: 'coldOpen', edl: planned.coldOpenEdl }
  // A loop is only ever played when this version's seam passed; the plan already builds it that way, this holds it to it.
  const edl = planned.edl.ending.kind === 'loop' && !planned.plan.loop.eligible ? { ...planned.edl, ending: { kind: 'cut' as const } } : planned.edl
  return { version: 'straight', edl }
}

/** Where an output-timeline second falls on the joined segments (before freezes), the inverse of `concatToOutputTime`. */
export function outputToConcatTime(freeze: Edl['freeze'], outSec: number): number {
  let shift = 0
  for (const f of [...freeze].sort((a, b) => a.atOutputT - b.atOutputT)) {
    const startOut = f.atOutputT + shift
    if (outSec < startOut) break
    if (outSec < startOut + f.holdSec) return f.atOutputT
    shift += f.holdSec
  }
  return outSec - shift
}

/**
 * The edit cut off at `cutOutSec` on its output timeline: later segments are
 * dropped, the one holding the cut is shortened, and freezes, zooms, overlays
 * and sounds that no longer fit go with it. A loop needs the original end, so
 * the result always ends in a plain cut.
 */
export function truncateEdl(edl: Edl, cutOutSec: number): Edl {
  const concatCut = outputToConcatTime(edl.freeze, cutOutSec)
  const starts = segmentStarts(edl.segments)
  const segments: EdlSegment[] = []
  edl.segments.forEach((s, i) => {
    const start = starts[i]!
    if (start >= concatCut - EPS) return
    if (start + segmentDuration(s) <= concatCut + EPS) segments.push(s)
    else segments.push({ ...s, srcEnd: s.srcStart + (concatCut - start) * s.speed })
  })
  const joined = concatDuration(segments)
  const freeze = edl.freeze.filter((f) => f.atOutputT < joined - EPS)
  const out = outputDuration({ ...edl, segments, freeze })
  return {
    segments,
    freeze,
    zoom: edl.zoom.filter((z) => z.t < out - EPS || z.t === 0),
    overlays: edl.overlays.filter((o) => o.t0 < out - EPS).map((o) => ({ ...o, t1: Math.min(o.t1, out) })),
    sfx: edl.sfx.filter((s) => s.t < out - EPS),
    ending: { kind: 'cut' }
  }
}

export interface PlatformInput {
  /** The chosen version's edit. */
  edl: Edl
  /** The clip's words, clip-relative seconds (the clock the edit's segments use). */
  words: Word[]
  /** The payoff, clip-relative seconds; it and its reaction beat are never trimmed off. Null when unknown. */
  payoffSec: number | null
}

export type PlatformPlan =
  | {
      action: 'export'
      platform: Platform
      edl: Edl
      finalSec: number
      capSec: number
      /** Seconds cut off the end to fit the cap; 0 when the version fit as it is. */
      trimmedSec: number
      /** The version ends in a loop (only ever true for a version whose seam passed). */
      loop: boolean
    }
  | { action: 'skip'; platform: Platform; finalSec: number; capSec: number; reason: string }

/**
 * The latest place to cut at or under `capSec` (output seconds): the end of a
 * word that ends a phrase or sentence, plus a short tail so the word is whole.
 * Null when the words offer none.
 */
export function capCutPoint(words: Word[], capSec: number): number | null {
  let cut: number | null = null
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!
    const next = words[i + 1]
    const gap = next ? next.t0 - w.t1 : Infinity
    if (gap < PLATFORM_RULES.phraseGapSec && !/[.!?]["')\]]*$/.test(w.text)) continue
    const realEnd = w.t1 + EDIT_RULES.loop.wordEndEarlySec
    const at = Math.min(realEnd + PLATFORM_RULES.cutTailSec, next ? Math.max(realEnd, next.t0) : Infinity)
    if (at > capSec + EPS) break
    cut = at
  }
  return cut
}

/** Plans `input` for `platform`: as it is when it fits the cap, cut at a phrase boundary just under it, or skipped. */
export function planPlatform(input: PlatformInput, platform: Platform): PlatformPlan {
  const capSec = EDIT_RULES.length.capSec[platform]
  const { edl } = input
  const finalSec = outputDuration(edl)
  if (finalSec <= capSec + EPS) return { action: 'export', platform, edl, finalSec, capSec, trimmedSec: 0, loop: edl.ending.kind === 'loop' }

  const skip = (reason: string): PlatformPlan => ({ action: 'skip', platform, finalSec, capSec, reason })
  const words = remapWordsToEdl(input.words, edl)
  const cut = capCutPoint(words, capSec)
  if (cut === null) return skip('no place to end it cleanly')
  const payoffOut = input.payoffSec === null ? 0 : sourceToOutputTime(edl.segments, edl.freeze, input.payoffSec, true)
  if (cut < payoffOut + EDIT_RULES.pacing.reactionBeatMinSec) return skip('the end would lose the payoff')
  if (cut < EDIT_RULES.length.finalFloorSec) return skip('it would end up too short')
  if (finalSec - cut > PLATFORM_RULES.maxTrimSec) return skip('too much would have to be cut')

  const trimmed = truncateEdl(edl, cut)
  return { action: 'export', platform, edl: trimmed, finalSec: outputDuration(trimmed), capSec, trimmedSec: finalSec - cut, loop: false }
}

/** One plain sentence for Review when a platform's plan shortened or left out the clip; null when it went out as it was. */
export function platformNote(plan: PlatformPlan): string | null {
  const label = PLATFORM_LABELS[plan.platform]
  if (plan.action === 'skip') return `Not made for ${label}: the clip is over ${plan.capSec} s.`
  if (plan.trimmedSec > 0) return `Ends a few seconds early on ${label} to stay within ${plan.capSec} s.`
  return null
}

/**
 * Keeps the text overlays (the hook quote, chat bubbles) inside a platform's
 * safe zone, in the frame's own pixels. Reels' zone sits inside the 3:4 grid
 * crop and the 4:5 feed crop, so anything on screen at frame 0 stays in the
 * cover too. Overlays already inside are returned untouched.
 */
export function fitOverlaysToZone(overlays: readonly OverlayCue[], zone: SafeZone, frame: { width: number; height: number }): OverlayCue[] {
  const half = PLATFORM_RULES.overlayHalfHeightPx
  const minY = (zone.top + half) / frame.height
  const maxY = (zone.bottom - half) / frame.height
  const minX = zone.left / frame.width
  const maxX = zone.right / frame.width
  return overlays.map((o) => {
    const y = Math.min(Math.max(o.pos.y, minY), maxY)
    const x = Math.min(Math.max(o.pos.x, minX), maxX)
    return y === o.pos.y && x === o.pos.x ? o : { ...o, pos: { ...o.pos, x, y } }
  })
}

/**
 * What decides whether two platforms produce the same file: the edit and every
 * text file burned in (captions and overlays are fitted to each platform's
 * zone, so a platform whose zone moved them differs). Equal signatures mean the
 * second platform can copy the first one's file instead of encoding it again.
 */
export function outputSignature(edl: Edl, ...burnedIn: (string | null)[]): string {
  return JSON.stringify([edl, ...burnedIn])
}
