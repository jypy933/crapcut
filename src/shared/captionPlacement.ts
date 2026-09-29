// Where the captions sit vertically for each output format, and the drag rules
// (limits, soft snap). One pure mapping used by the review preview, the ASS
// burn-in and the chat box's "stay above the captions" rule, so the caption
// the streamer places in review is the caption that is exported. The caption
// block is always centred horizontally; only its height is his to move.

import type { RenderFormat } from './layoutGeometry'
import { boxSnapTargets, clampNum, roundNorm, safeArea, snapAxisHome } from './overlayPosition'
import type { CaptionSettings } from './types'

/** The 9:16 default: low in the frame but above what the short-video apps cover. */
export const CAPTION_DEFAULT_Y = 0.72

/** How far the caption block may be dragged (its centre, as a fraction of the frame height). */
export const CAPTION_Y_MIN = 0.08
export const CAPTION_Y_MAX = 0.92

/** A 16:9 export has no app interface to avoid, so the derived default sits a little lower. */
const HORIZONTAL_LIFT = 0.1
const HORIZONTAL_DERIVED_MIN = 0.6

/** Half the height of a two-line caption block, as a fraction of the frame height (for edge snapping). */
const HALF_BLOCK: Record<RenderFormat, number> = { vertical: 0.046, horizontal: 0.067 }

export const clampCaptionY = (y: number): number => clampNum(y, CAPTION_Y_MIN, CAPTION_Y_MAX)

/**
 * The default caption height for a format. In 16:9 it follows the clip's 9:16
 * height (`verticalY`), as every clip did before 16:9 had its own position.
 */
export function defaultCaptionY(format: RenderFormat, verticalY = CAPTION_DEFAULT_Y): number {
  return format === 'vertical' ? CAPTION_DEFAULT_Y : clampNum(verticalY + HORIZONTAL_LIFT, HORIZONTAL_DERIVED_MIN, CAPTION_Y_MAX)
}

/**
 * The caption's vertical centre (0..1 of the frame height) for a format: what
 * the streamer dragged it to, or the default. Clips saved before per-format
 * positions existed have no `yHorizontal` and keep the derived 16:9 height.
 */
export function captionY(captions: Pick<CaptionSettings, 'y' | 'yHorizontal'>, format: RenderFormat): number {
  if (format === 'vertical') return clampCaptionY(captions.y)
  return typeof captions.yHorizontal === 'number' ? clampCaptionY(captions.yHorizontal) : defaultCaptionY('horizontal', captions.y)
}

/** Whether the clip's captions for a format are somewhere other than the default. */
export function captionMoved(captions: Pick<CaptionSettings, 'y' | 'yHorizontal'>, format: RenderFormat): boolean {
  return format === 'vertical' ? Math.abs(clampCaptionY(captions.y) - CAPTION_DEFAULT_Y) > 1e-6 : typeof captions.yHorizontal === 'number'
}

/**
 * The settings after the captions were placed at `y` for `format`. Placing
 * them back on the default height stores the default (no stray override).
 */
export function withCaptionY(captions: CaptionSettings, format: RenderFormat, y: number): CaptionSettings {
  const next = roundNorm(clampCaptionY(y))
  if (format === 'vertical') return { ...captions, y: next }
  const out = { ...captions }
  delete out.yHorizontal
  return Math.abs(next - defaultCaptionY('horizontal', captions.y)) < 1e-6 ? out : { ...out, yHorizontal: next }
}

/** The settings with the captions of one format back at their default height. */
export function resetCaptionY(captions: CaptionSettings, format: RenderFormat): CaptionSettings {
  if (format === 'vertical') return { ...captions, y: CAPTION_DEFAULT_Y }
  const out = { ...captions }
  delete out.yHorizontal
  return out
}

/**
 * Moves the caption centre to `y` (already where the pointer is): limits it to
 * the draggable range and, unless `snap` is off, pulls it onto the default
 * height, the middle of the frame or the block's edges against the platform
 * safe area. `guide` is the frame line that lined up, for drawing.
 */
export function placeCaptionY(y: number, format: RenderFormat, opts: { snap?: boolean; verticalY?: number } = {}): { y: number; guide: number | null } {
  const clamped = clampCaptionY(y)
  if (opts.snap === false) return { y: clamped, guide: null }
  const half = HALF_BLOCK[format]
  const area = safeArea(format)
  const home = defaultCaptionY(format, opts.verticalY)
  // Work on the block's top edge: its edges then snap to the safe-area lines and
  // its centre to the middle of the frame. The default height wins when close.
  const edges = boxSnapTargets(half * 2, [area.top, area.bottom]).filter((t) => t.at + half >= CAPTION_Y_MIN && t.at + half <= CAPTION_Y_MAX)
  const snapped = snapAxisHome(clamped - half, { at: home - half, guide: home }, edges)
  return { y: clampCaptionY(snapped.value + half), guide: snapped.guide }
}
