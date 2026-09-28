// Crop geometry for the output layouts, shared by the export (FFmpeg) and the
// review preview (canvas) so both frame the picture identically.

import type { Layout, Rect } from './types'

export type RenderFormat = 'vertical' | 'horizontal'

export interface PixelRect {
  x: number
  y: number
  w: number
  h: number
}

export interface Size {
  width: number
  height: number
}

export const OUTPUT_SIZE: Record<RenderFormat, Size> = {
  vertical: { width: 1080, height: 1920 },
  horizontal: { width: 1920, height: 1080 }
}

const even = (n: number): number => Math.max(2, Math.round(n / 2) * 2)
const clamp = (n: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, n))

/** Normalised rect → whole even pixels inside the frame. */
export function toPixels(r: Rect, size: Size): PixelRect {
  const x = clamp(r.x, 0, 1)
  const y = clamp(r.y, 0, 1)
  const w = clamp(r.w, 0.01, 1 - x)
  const h = clamp(r.h, 0.01, 1 - y)
  const px: PixelRect = { x: even(x * size.width), y: even(y * size.height), w: even(w * size.width), h: even(h * size.height) }
  px.w = Math.min(px.w, size.width - px.x)
  px.h = Math.min(px.h, size.height - px.y)
  if (px.w % 2) px.w -= 1
  if (px.h % 2) px.h -= 1
  return px
}

/** The largest rect of aspect `aspect` (w/h) inside `r`, centred on it. */
export function fitAspect(r: PixelRect, aspect: number, frame: Size): PixelRect {
  let w = r.w
  let h = r.h
  if (w / h > aspect) w = h * aspect
  else h = w / aspect
  w = Math.min(even(w), frame.width)
  h = Math.min(even(h), frame.height)
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  const x = clamp(even(cx - w / 2), 0, frame.width - w)
  const y = clamp(even(cy - h / 2), 0, frame.height - h)
  return { x, y, w, h }
}

export interface VerticalGeometry {
  cam: PixelRect | null
  camHeight: number
  game: PixelRect
  gameHeight: number
}

/**
 * Cam + game: the facecam fills the top at full width (between a quarter and
 * 45% of the height), the game fills the rest.
 */
export function verticalGeometry(layout: Layout, source: Size): VerticalGeometry {
  const out = OUTPUT_SIZE.vertical
  const gameArea = toPixels(layout.game, source)
  if (layout.kind === 'cam_game' && layout.cam) {
    const camArea = toPixels(layout.cam, source)
    const natural = (out.width * camArea.h) / camArea.w
    const camHeight = even(clamp(natural, out.height * 0.25, out.height * 0.45))
    const gameHeight = out.height - camHeight
    return {
      cam: fitAspect(camArea, out.width / camHeight, source),
      camHeight,
      game: fitAspect(gameArea, out.width / gameHeight, source),
      gameHeight
    }
  }
  return { cam: null, camHeight: 0, game: fitAspect(gameArea, out.width / out.height, source), gameHeight: out.height }
}

