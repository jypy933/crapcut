// Keeps burned-in captions inside the platform safe zones (docs/auto-edit-research.md
// section 2.5). Pure: estimates how big a caption block is from its text and
// style, checks it against a zone and, when it does not fit, moves it (and
// narrows its wrap) just enough. Shared by the ASS burn-in (main) and the
// review preview (renderer), so both show the same fitted captions.
// Everything tunable is a constant up here.

import { displayText, groupWords } from './captions'
import type { CaptionStyle } from './captionStyles'
import type { RenderFormat } from './layoutGeometry'
import type { Word } from './types'

/** Caption font size in output pixels (1080x1920 or 1920x1080). */
export const captionFontSize = (format: RenderFormat): number => (format === 'vertical' ? 88 : 72)

/** Caption outline width in output pixels for a preset. */
export const captionOutline = (format: RenderFormat, preset: Pick<CaptionStyle, 'outlineScale'>): number => (format === 'vertical' ? 7 : 6) * preset.outlineScale

/** The parts of a caption style the fit reads and may change (`AssStyle` in main satisfies it). */
export interface FitStyle {
  width: number
  height: number
  fontSize: number
  outline: number
  /** Vertical centre, 0..1 of the frame height. */
  y: number
  uppercase: boolean
  emphasisScale: number
  /** Left and right margin in pixels, where the text wraps; 6% of the width when omitted. */
  marginX?: number
}

/** Pixel edges of the area text may occupy, in the frame's own pixels (1080x1920 or 1920x1080). */
export interface SafeZone {
  left: number
  top: number
  right: number
  bottom: number
}

export type Platform = 'tiktok' | 'shorts' | 'reels'

/** Practical per-platform text limits for a 1080x1920 export (research table 2.5). */
export const SAFE_ZONES: Record<Platform, SafeZone> = {
  tiktok: { left: 80, top: 160, right: 960, bottom: 1480 },
  shorts: { left: 60, top: 225, right: 960, bottom: 1350 },
  reels: { left: 65, top: 285, right: 1015, bottom: 1250 }
}

/** 16:9 has no app interface over it, only the usual 5% title-safe margin (1920x1080). */
export const HORIZONTAL_ZONE: SafeZone = { left: 96, top: 54, right: 1824, bottom: 1026 }

/** The platform a vertical export is checked against until exports are made per platform: the loosest of the three. */
export const DEFAULT_PLATFORM: Platform = 'tiktok'

export function safeZone(format: RenderFormat, platform: Platform = DEFAULT_PLATFORM): SafeZone {
  return format === 'vertical' ? SAFE_ZONES[platform] : HORIZONTAL_ZONE
}

/** How wide and tall caption text runs, in fractions of the font size (Montserrat Black and similar heavy fonts). */
export const CAPTION_METRICS = { upperEm: 0.72, lowerEm: 0.6, spaceEm: 0.28, lineHeightEm: 1.22 }

/** ASS side margin the caption style uses when it has no `marginX` (6% of the frame width, as `buildAss` does). */
export const defaultMarginX = (width: number): number => Math.round(width * 0.06)

export function textWidthPx(text: string, fontSize: number): number {
  let em = 0
  for (const ch of text) {
    if (ch === ' ') em += CAPTION_METRICS.spaceEm
    else if (ch !== ch.toLocaleLowerCase()) em += CAPTION_METRICS.upperEm
    else if (/\d/.test(ch)) em += CAPTION_METRICS.upperEm
    else em += CAPTION_METRICS.lowerEm
  }
  return em * fontSize
}

/** Greedy word wrap of `text` into lines no wider than `availPx` (a word wider than that stays on its own line). */
export function wrapLines(text: string, fontSize: number, availPx: number): string[] {
  const lines: string[] = []
  let line = ''
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? `${line} ${word}` : word
    if (line && textWidthPx(next, fontSize) > availPx) {
      lines.push(line)
      line = word
    } else line = next
  }
  if (line) lines.push(line)
  return lines
}

export interface BlockInput {
  /** What each caption group shows on screen (already uppercased when the style does). */
  texts: string[]
  fontSize: number
  outline: number
  /** Largest size bump any word gets (1 for none). */
  scale: number
  frameWidth: number
  marginX: number
}

export interface CaptionBlock {
  /** Tallest a caption block gets, in pixels. */
  height: number
  /** Widest line, in pixels. */
  widest: number
  lines: number
}

/** The worst-case caption block over all groups of a clip. */
export function estimateCaptionBlock(input: BlockInput): CaptionBlock {
  const avail = Math.max(1, input.frameWidth - 2 * input.marginX)
  let widest = 0
  let lines = 0
  for (const text of input.texts) {
    const wrapped = wrapLines(text, input.fontSize, avail)
    lines = Math.max(lines, wrapped.length)
    for (const l of wrapped) widest = Math.max(widest, textWidthPx(l, input.fontSize))
  }
  const height = lines * input.fontSize * Math.max(1, input.scale) * CAPTION_METRICS.lineHeightEm + (lines > 0 ? 2 * input.outline : 0)
  return { height, widest, lines }
}

export interface ZoneOverflow {
  left: number
  top: number
  right: number
  bottom: number
}

/** How far (pixels, 0 when inside) a block centred at (`frameWidth / 2`, `centreY`) spills past each edge of `zone`. */
export function blockOverflow(block: CaptionBlock, centreY: number, frameWidth: number, zone: SafeZone): ZoneOverflow {
  const cx = frameWidth / 2
  const over = (n: number): number => Math.max(0, Math.round(n))
  return {
    left: over(zone.left - (cx - block.widest / 2)),
    right: over(cx + block.widest / 2 - zone.right),
    top: over(zone.top - (centreY - block.height / 2)),
    bottom: over(centreY + block.height / 2 - zone.bottom)
  }
}

export const overflowsZone = (o: ZoneOverflow): boolean => o.left > 0 || o.top > 0 || o.right > 0 || o.bottom > 0

export interface CaptionFit<S extends FitStyle> {
  style: S
  /** True when the placement or the wrap width had to change. */
  adjusted: boolean
  /** What spilled past the zone before the fix (all zero when nothing did). */
  before: ZoneOverflow
}

/**
 * The caption style with its height (and, when the widest line would spill
 * sideways, its wrap width) pushed just inside `zone`. Captions are centred
 * horizontally, so the side limit is the nearer of the zone's two edges. A clip
 * with no captions, or a style that already fits, comes back unchanged.
 */
export function fitCaptionStyle<S extends FitStyle>(words: Word[], style: S, zone: SafeZone): CaptionFit<S> {
  const none: ZoneOverflow = { left: 0, top: 0, right: 0, bottom: 0 }
  const texts = groupWords(words).map((g) => g.words.map((w) => displayText(w.text, style.uppercase)).join(' '))
  if (texts.length === 0) return { style, adjusted: false, before: none }

  const input: BlockInput = { texts, fontSize: style.fontSize, outline: style.outline, scale: style.emphasisScale, frameWidth: style.width, marginX: style.marginX ?? defaultMarginX(style.width) }
  const centreY = style.y * style.height
  const first = estimateCaptionBlock(input)
  const before = blockOverflow(first, centreY, style.width, zone)
  if (!overflowsZone(before)) return { style, adjusted: false, before }

  // Sideways: wrap earlier, by the zone's nearer side.
  let marginX = input.marginX
  let block = first
  if (before.left > 0 || before.right > 0) {
    marginX = Math.max(marginX, Math.ceil(Math.max(zone.left, style.width - zone.right)))
    block = estimateCaptionBlock({ ...input, marginX })
  }
  // Up or down: the centre that keeps the (possibly taller) block inside.
  const lo = zone.top + block.height / 2
  const hi = zone.bottom - block.height / 2
  const y = (lo > hi ? (zone.top + zone.bottom) / 2 : Math.min(hi, Math.max(lo, centreY))) / style.height
  const fitted: S = { ...style, y: Math.round(y * 10000) / 10000, ...(marginX !== input.marginX ? { marginX } : {}) }
  return { style: fitted, adjusted: true, before }
}
