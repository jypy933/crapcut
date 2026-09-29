// Crop geometry for the output layouts, shared by the export (FFmpeg), the
// review preview (canvas) and the layout editor so all three frame the picture
// identically. Also the editor's rectangle maths (move, resize, aspect locks),
// kept here so it is pure and unit-tested.

import type { Layout, LayoutKind, Rect } from './types'

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

/** Normalised rect -> whole even pixels inside the frame. */
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

/** What the export and the preview draw for a layout and format: one crop, a blurred fill, or a cam stacked over the game. */
export type LayoutPlan =
  | { mode: 'crop'; src: PixelRect }
  | { mode: 'blur'; src: PixelRect }
  | { mode: 'stack'; cam: PixelRect; camHeight: number; game: PixelRect; gameHeight: number }

/**
 * The single place that decides which part of the source frame goes where.
 * A horizontal export uses the game area cropped to 16:9 for a "full frame"
 * layout and the whole frame otherwise (the game area of a cam layout is a
 * vertical slot, not something to cut a landscape frame from).
 */
export function layoutPlan(layout: Layout, format: RenderFormat, source: Size): LayoutPlan {
  if (format === 'horizontal') {
    const area: PixelRect = layout.kind === 'blur_fill' ? toPixels(layout.game, source) : { x: 0, y: 0, w: source.width, h: source.height }
    return { mode: 'crop', src: fitAspect(area, OUTPUT_SIZE.horizontal.width / OUTPUT_SIZE.horizontal.height, source) }
  }
  if (layout.kind === 'blur_fill') return { mode: 'blur', src: toPixels(layout.game, source) }
  const g = verticalGeometry(layout, source)
  if (g.cam) return { mode: 'stack', cam: g.cam, camHeight: g.camHeight, game: g.game, gameHeight: g.gameHeight }
  return { mode: 'crop', src: g.game }
}

/** The stacked cam's height for an output of `out` (the full-size value scaled, kept even), and what is left for the game. */
export function stackHeights(camHeight: number, out: Size): { camHeight: number; gameHeight: number } {
  const full = OUTPUT_SIZE.vertical.height
  const cam = out.height === full ? camHeight : even((camHeight * out.height) / full)
  return { camHeight: cam, gameHeight: out.height - cam }
}

// ---- editing rectangles (normalised 0..1 of the source frame) ----

/** Smallest a rectangle can be dragged to, as a fraction of the frame. */
export const MIN_RECT = 0.04

export type Handle = 'move' | 'n' | 's' | 'e' | 'w' | 'nw' | 'ne' | 'sw' | 'se'

const FULL_RECT: Rect = { x: 0, y: 0, w: 1, h: 1 }

/** A sensible first facecam box: the bottom-right corner, where streamers usually put it. */
export const DEFAULT_CAM: Rect = { x: 0.72, y: 0.62, w: 0.26, h: 0.34 }

/** Keeps a rectangle inside the frame and at least `min` wide and tall. */
export function clampRect(r: Rect, min = MIN_RECT): Rect {
  const w = clamp(r.w, min, 1)
  const h = clamp(r.h, min, 1)
  return { x: clamp(r.x, 0, 1 - w), y: clamp(r.y, 0, 1 - h), w, h }
}

/** Rounds to four decimals, for saving. */
export function roundRect(r: Rect): Rect {
  const f = (n: number): number => Math.round(n * 10000) / 10000
  return { x: f(r.x), y: f(r.y), w: f(r.w), h: f(r.h) }
}

/** Width over height of a normalised rectangle in source pixels. */
export function rectAspect(r: Rect, source: Size): number {
  return (r.w * source.width) / (r.h * source.height)
}

/** The largest rectangle of pixel aspect `aspect` (w/h) inside `r`, centred on it. */
export function fitRectAspect(r: Rect, aspect: number, source: Size): Rect {
  let w = r.w
  let h = (r.w * source.width) / aspect / source.height
  if (h > r.h) {
    h = r.h
    w = (r.h * source.height * aspect) / source.width
  }
  return { x: r.x + (r.w - w) / 2, y: r.y + (r.h - h) / 2, w, h }
}

/**
 * Gives `r` a new pixel aspect around its centre, keeping its width where the
 * frame allows (so a rectangle that is nudged back and forth does not shrink),
 * then pulling it into the frame.
 */
export function reaspectRect(r: Rect, aspect: number, source: Size): Rect {
  const cx = r.x + r.w / 2
  const cy = r.y + r.h / 2
  let w = r.w
  let h = (w * source.width) / aspect / source.height
  if (h > 1) {
    h = 1
    w = (h * source.height * aspect) / source.width
  }
  if (w > 1) {
    w = 1
    h = (w * source.width) / aspect / source.height
  }
  return { x: clamp(cx - w / 2, 0, 1 - w), y: clamp(cy - h / 2, 0, 1 - h), w, h }
}

/** The pixel aspect range the facecam box can have: the stacked cam slot is between a quarter and 45% of the height. */
export function camAspectRange(): { min: number; max: number } {
  const out = OUTPUT_SIZE.vertical
  return { min: out.width / (out.height * 0.45), max: out.width / (out.height * 0.25) }
}

/** Narrows or shortens a facecam box, around its centre, until its aspect is one the layout can show uncropped. */
export function constrainCam(cam: Rect, source: Size): Rect {
  const { min, max } = camAspectRange()
  const a = rectAspect(cam, source)
  if (a >= min && a <= max) return cam
  return reaspectRect(cam, clamp(a, min, max), source)
}

/** Pixel aspect of the game area's slot below the facecam (the whole vertical frame's aspect when there is no cam). */
export function gameSlotAspect(cam: Rect | null, source: Size): number {
  const out = OUTPUT_SIZE.vertical
  if (!cam) return out.width / out.height
  const camPx = toPixels(cam, source)
  const camHeight = even(clamp((out.width * camPx.h) / camPx.w, out.height * 0.25, out.height * 0.45))
  return out.width / (out.height - camHeight)
}

/**
 * A layout as the editor should show it: the rectangles snapped to what the
 * export really crops, so nothing on screen is silently trimmed. Layouts saved
 * before the rectangles were locked to their slots (a game area of the whole
 * frame, say) open as the centred crop the export already used for them.
 */
export function normalizeLayout(layout: Layout, source: Size): Layout {
  const game = clampRect(layout.game)
  if (layout.kind === 'blur_fill') return { ...layout, cam: null, game }
  if (layout.kind === 'cam_game' && layout.cam) {
    const cam = constrainCam(clampRect(layout.cam), source)
    return { ...layout, cam, game: fitRectAspect(game, gameSlotAspect(cam, source), source) }
  }
  return { ...layout, cam: null, game: fitRectAspect(game, gameSlotAspect(null, source), source) }
}

export interface DragOptions {
  /** Keep this pixel aspect (w/h) while resizing. */
  aspect?: number
  /** Free resizing, but never outside this pixel aspect range (w/h). */
  aspectRange?: { min: number; max: number }
  min?: number
}

/**
 * Moves or resizes `r0` by a drag of (`dx`, `dy`) (fractions of the frame),
 * staying inside the frame. Corner handles anchor the opposite corner and, with
 * an aspect lock, scale from it; edge handles anchor the opposite edge and, with
 * a lock, grow the other axis around the centre.
 */
export function dragRect(r0: Rect, handle: Handle, dx: number, dy: number, source: Size, opts: DragOptions = {}): Rect {
  const { width: W, height: H } = source
  const min = opts.min ?? MIN_RECT
  const minW = min * W
  const minH = min * H
  const X = r0.x * W
  const Y = r0.y * H
  const RW = r0.w * W
  const RH = r0.h * H
  const dxp = dx * W
  const dyp = dy * H
  const norm = (x: number, y: number, w: number, h: number): Rect => ({ x: x / W, y: y / H, w: w / W, h: h / H })

  if (handle === 'move') return norm(clamp(X + dxp, 0, W - RW), clamp(Y + dyp, 0, H - RH), RW, RH)

  const hasW = handle.includes('w')
  const hasE = handle.includes('e')
  const hasN = handle.includes('n')
  const hasS = handle.includes('s')
  const aspect = opts.aspect

  if (!aspect) {
    let left = X
    let right = X + RW
    let top = Y
    let bottom = Y + RH
    if (hasW) left = clamp(left + dxp, 0, right - minW)
    if (hasE) right = clamp(right + dxp, left + minW, W)
    if (hasN) top = clamp(top + dyp, 0, bottom - minH)
    if (hasS) bottom = clamp(bottom + dyp, top + minH, H)
    const range = opts.aspectRange
    if (range) {
      // Hold the dragged edge back where the box would get an aspect outside the range.
      const a = (right - left) / (bottom - top)
      const target = a > range.max ? range.max : a < range.min ? range.min : null
      if (target !== null) {
        if ((hasW || hasE) && !(hasN || hasS)) {
          const w = (bottom - top) * target
          if (hasW) left = right - w
          else right = left + w
        } else {
          const h = (right - left) / target
          if (hasN) top = bottom - h
          else bottom = top + h
        }
      }
    }
    return norm(left, top, right - left, bottom - top)
  }

  const loW = Math.max(minW, minH * aspect)
  const fitW = (w: number, hi: number): number => clamp(w, Math.min(loW, hi), hi)

  if ((hasW || hasE) && (hasN || hasS)) {
    // Corner: the opposite corner stays put.
    const ax = hasE ? X : X + RW
    const ay = hasS ? Y : Y + RH
    const rawW = hasE ? X + RW + dxp - ax : ax - (X + dxp)
    const rawH = hasS ? Y + RH + dyp - ay : ay - (Y + dyp)
    const hi = Math.min(hasE ? W - ax : ax, (hasS ? H - ay : ay) * aspect)
    const w = fitW(Math.max(rawW, rawH * aspect), hi)
    const h = w / aspect
    return norm(hasE ? ax : ax - w, hasS ? ay : ay - h, w, h)
  }
  if (hasW || hasE) {
    const cy = Y + RH / 2
    const ax = hasE ? X : X + RW
    const raw = hasE ? X + RW + dxp - ax : ax - (X + dxp)
    const hi = Math.min(hasE ? W - ax : ax, 2 * Math.min(cy, H - cy) * aspect)
    const w = fitW(raw, hi)
    const h = w / aspect
    return norm(hasE ? ax : ax - w, cy - h / 2, w, h)
  }
  const cx = X + RW / 2
  const ay = hasS ? Y : Y + RH
  const raw = (hasS ? Y + RH + dyp - ay : ay - (Y + dyp)) * aspect
  const hi = Math.min((hasS ? H - ay : ay) * aspect, 2 * Math.min(cx, W - cx))
  const w = fitW(raw, hi)
  const h = w / aspect
  return norm(cx - w / 2, hasS ? ay : ay - h, w, h)
}

/** Moves or resizes one rectangle of a layout, keeping the game area locked to the slot the facecam leaves it. */
export function dragLayout(layout: Layout, target: 'cam' | 'game', handle: Handle, dx: number, dy: number, source: Size): Layout {
  if (target === 'cam' && layout.cam) {
    // Free-form, but never outside the aspects the layout can show uncropped.
    const cam = dragRect(layout.cam, handle, dx, dy, source, { aspectRange: camAspectRange() })
    return { ...layout, cam, game: reaspectRect(layout.game, gameSlotAspect(cam, source), source) }
  }
  if (layout.kind === 'blur_fill') return { ...layout, game: dragRect(layout.game, handle, dx, dy, source) }
  return { ...layout, game: dragRect(layout.game, handle, dx, dy, source, { aspect: gameSlotAspect(layout.cam, source) }) }
}

/** A new layout of `kind`, snapped to its slots for this source. */
export function newLayout(id: string, name: string, kind: LayoutKind, source: Size): Layout {
  return normalizeLayout({ id, name, kind, cam: kind === 'cam_game' ? DEFAULT_CAM : null, game: FULL_RECT }, source)
}

/** Switches a layout's kind, giving it a facecam box when it needs one, and snaps it. */
export function withKind(layout: Layout, kind: LayoutKind, source: Size): Layout {
  return normalizeLayout({ ...layout, kind, cam: kind === 'cam_game' ? (layout.cam ?? DEFAULT_CAM) : null }, source)
}

/** A copy with a fresh id and a name like "Name copy" that no other layout has. */
export function duplicateLayout(layout: Layout, id: string, existingNames: readonly string[]): Layout {
  const base = layout.name.replace(/ copy( \d+)?$/, '').slice(0, 30)
  let name = `${base} copy`
  for (let n = 2; existingNames.includes(name); n++) name = `${base} copy ${n}`
  return { ...layout, id, name, cam: layout.cam ? { ...layout.cam } : null, game: { ...layout.game } }
}
