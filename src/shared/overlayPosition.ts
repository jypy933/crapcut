// Where an overlay (the captions, the chat box, anything added later) sits on
// the output frame, as one small model shared by the review preview and the
// ASS burn-in so a dragged overlay lands in the same place in both.
//
// A position is a point in the OUTPUT frame as fractions of its width and
// height (0..1), so it means the same thing at every preview size and in the
// exported file. What the point refers to (a box's top-left corner, a text
// block's centre) is up to each overlay; the helpers here do the clamping,
// snapping and pixel conversion, and are pure so they are unit-tested.

import type { RenderFormat, Size } from './layoutGeometry'

export interface NormPos {
  x: number
  y: number
}

/** A rectangle in the output frame, as fractions of its width and height. */
export interface NormBox {
  x: number
  y: number
  w: number
  h: number
}

/** One saved position per output format (9:16 and 16:9 need different places). */
export type FormatPositions = Partial<Record<RenderFormat, NormPos>>

/** How close (as a fraction of the frame) a dragged overlay has to come before it snaps. */
export const SNAP_DISTANCE = 0.02

export const clampNum = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/** Rounds to four decimals, for saving. */
export const roundNorm = (n: number): number => Math.round(n * 10000) / 10000

/** Keeps the top-left corner of a `w` x `h` box (fractions) so the whole box stays inside the frame. */
export function clampBoxPos(pos: NormPos, box: { w: number; h: number }): NormPos {
  return { x: clampNum(pos.x, 0, Math.max(0, 1 - box.w)), y: clampNum(pos.y, 0, Math.max(0, 1 - box.h)) }
}

/** A frame position (fractions) -> whole output pixels, exactly what an ASS `\pos` takes. */
export function toOutputPixels(pos: NormPos, size: Size): NormPos {
  return { x: Math.round(pos.x * size.width), y: Math.round(pos.y * size.height) }
}

/** A frame position (fractions) -> CSS percentages of the preview frame. */
export function toPercent(pos: NormPos): { left: string; top: string } {
  return { left: `${pos.x * 100}%`, top: `${pos.y * 100}%` }
}

/** A pointer position over the preview frame -> fractions of the frame (not clamped). */
export function pointerToNorm(clientX: number, clientY: number, frame: { left: number; top: number; width: number; height: number }): NormPos {
  return { x: (clientX - frame.left) / Math.max(1, frame.width), y: (clientY - frame.top) / Math.max(1, frame.height) }
}

/** A value the dragged coordinate may snap to, and the guide line to draw while it does. */
export interface SnapTarget {
  /** The coordinate the value jumps to. */
  at: number
  /** Where to draw the guide (the edge or line that lined up). */
  guide: number
}

/**
 * Soft snap on one axis: the nearest target within `distance` wins, otherwise
 * the value is left exactly where the pointer put it.
 */
export function snapAxis(value: number, targets: readonly SnapTarget[], distance = SNAP_DISTANCE): { value: number; guide: number | null } {
  let best: SnapTarget | null = null
  let bestGap = distance
  for (const t of targets) {
    const gap = Math.abs(t.at - value)
    if (gap <= bestGap) {
      best = t
      bestGap = gap
    }
  }
  return best ? { value: best.at, guide: best.guide } : { value, guide: null }
}

/** Like `snapAxis`, but `home` (the overlay's default place) wins whenever it is in range, even over a nearer target. */
export function snapAxisHome(value: number, home: SnapTarget, others: readonly SnapTarget[], distance = SNAP_DISTANCE): { value: number; guide: number | null } {
  const atHome = snapAxis(value, [home], distance)
  return atHome.guide !== null ? atHome : snapAxis(value, others, distance)
}

/**
 * Snap targets for the START coordinate of a box of `size` along one axis:
 * its start edge on each line, its end edge on each line, and (optionally) its
 * centre on the frame's middle.
 */
export function boxSnapTargets(size: number, lines: readonly number[], centre = true): SnapTarget[] {
  const targets: SnapTarget[] = []
  for (const line of lines) {
    targets.push({ at: line, guide: line }, { at: line - size, guide: line })
  }
  if (centre) targets.push({ at: 0.5 - size / 2, guide: 0.5 })
  return targets
}

export interface SafeArea {
  /** Fractions of the frame kept clear at each edge. */
  top: number
  bottom: number
  left: number
  right: number
  /** The parts of the frame the platform's own buttons and text cover (drawn as guides). */
  covered: NormBox[]
}

/**
 * What TikTok, YouTube Shorts and Instagram Reels cover on a 9:16 video (the
 * search bar and tabs on top, the caption/description and navigation at the
 * bottom, the like/comment/share column on the right), taking the worst of
 * the three. A 16:9 export has no such interface, so it only keeps the usual
 * title-safe margin.
 */
export function safeArea(format: RenderFormat): SafeArea {
  if (format === 'vertical') {
    const top = 0.11
    const bottom = 0.78
    const right = 0.86
    return {
      top,
      bottom,
      left: 0.045,
      right,
      covered: [
        { x: 0, y: 0, w: 1, h: top },
        { x: 0, y: bottom, w: 1, h: 1 - bottom },
        { x: right, y: 0.45, w: 1 - right, h: bottom - 0.45 }
      ]
    }
  }
  const m = 0.05
  return {
    top: m,
    bottom: 1 - m,
    left: m,
    right: 1 - m,
    covered: [
      { x: 0, y: 0, w: 1, h: m },
      { x: 0, y: 1 - m, w: 1, h: m },
      { x: 0, y: m, w: m, h: 1 - 2 * m },
      { x: 1 - m, y: m, w: m, h: 1 - 2 * m }
    ]
  }
}
