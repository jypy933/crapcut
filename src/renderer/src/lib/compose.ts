// Draws the review preview on a canvas with the same crop math the export uses.

import { fitAspect, OUTPUT_SIZE, toPixels, verticalGeometry, type RenderFormat } from '@shared/layoutGeometry'
import type { Layout } from '@shared/types'

export const FALLBACK_LAYOUT: Layout = { id: 'default-blur', name: 'Full frame', kind: 'blur_fill', cam: null, game: { x: 0, y: 0, w: 1, h: 1 } }

const BACKDROP_SCALE = 8
let backdropCtx: CanvasRenderingContext2D | null = null

function backdrop(w: number, h: number): CanvasRenderingContext2D | null {
  if (!backdropCtx) backdropCtx = document.createElement('canvas').getContext('2d')
  if (!backdropCtx) return null
  const c = backdropCtx.canvas
  if (c.width !== w || c.height !== h) {
    c.width = w
    c.height = h
  }
  backdropCtx.fillStyle = '#000'
  backdropCtx.fillRect(0, 0, w, h)
  return backdropCtx
}

export function drawFrame(ctx: CanvasRenderingContext2D, video: HTMLVideoElement, layout: Layout, format: RenderFormat): void {
  const canvas = ctx.canvas
  const W = canvas.width
  const H = canvas.height
  const src = { width: video.videoWidth, height: video.videoHeight }
  ctx.fillStyle = '#000'
  ctx.fillRect(0, 0, W, H)
  if (!src.width || !src.height) return
  const out = OUTPUT_SIZE[format]
  const k = W / out.width

  if (format === 'horizontal') {
    const g = fitAspect(toPixels(layout.game, src), out.width / out.height, src)
    ctx.drawImage(video, g.x, g.y, g.w, g.h, 0, 0, W, H)
    return
  }

  if (layout.kind === 'blur_fill') {
    const g = toPixels(layout.game, src)
    // Background: the frame scaled to cover, blurred and slightly darkened.
    const cover = Math.max(W / g.w, H / g.h)
    const bw = g.w * cover
    const bh = g.h * cover
    // Blurring the full-size canvas every frame is costly; blur a small copy
    // and scale it up instead, which looks the same for a soft background.
    const bg = backdrop(Math.ceil(W / BACKDROP_SCALE), Math.ceil(H / BACKDROP_SCALE))
    if (bg) {
      const s = 1 / BACKDROP_SCALE
      bg.filter = `blur(${Math.max(1, Math.round((24 * k) / BACKDROP_SCALE))}px) brightness(0.94)`
      bg.drawImage(video, g.x, g.y, g.w, g.h, ((W - bw) / 2) * s, ((H - bh) / 2) * s, bw * s, bh * s)
      ctx.save()
      ctx.imageSmoothingQuality = 'high'
      ctx.drawImage(bg.canvas, 0, 0, bg.canvas.width, bg.canvas.height, 0, 0, W, H)
      ctx.restore()
    }
    const fh = (W * g.h) / g.w
    ctx.drawImage(video, g.x, g.y, g.w, g.h, 0, (H - fh) / 2, W, fh)
    return
  }

  const geo = verticalGeometry(layout, src)
  if (geo.cam) {
    const camH = geo.camHeight * k
    ctx.drawImage(video, geo.cam.x, geo.cam.y, geo.cam.w, geo.cam.h, 0, 0, W, camH)
    ctx.drawImage(video, geo.game.x, geo.game.y, geo.game.w, geo.game.h, 0, camH, W, H - camH)
  } else {
    ctx.drawImage(video, geo.game.x, geo.game.y, geo.game.w, geo.game.h, 0, 0, W, H)
  }
}
