// Turns a clip's chat messages into a calm, scrolling overlay: pure layout
// logic shared by the ASS burn-in (main/core/ass.ts) and the review preview
// (renderer), so what the user sees in review is what gets exported.
//
// Chat timestamps only have 1-second precision (TwitchDownloaderCLI's text
// log), so messages that share a second are spread evenly across it instead
// of popping in as a block. Messages stack like a normal chat log: newest at
// the bottom, older ones pushed up and off after a few more arrive.

import { assEscape, inlineColor } from './assText'
import { OUTPUT_SIZE, verticalGeometry, type RenderFormat, type Size } from './layoutGeometry'
import { boxSnapTargets, clampBoxPos, roundNorm, safeArea, snapAxisHome, type FormatPositions, type NormPos } from './overlayPosition'
import type { ChatMessage, Layout } from './types'

export interface ChatOverlayOptions {
  /** How many messages are visible in the stack at once. */
  maxLines: number
  /** A long message wraps into at most this many lines before it is truncated. */
  maxWrapLines: number
  /** How long a new line takes to fade in. */
  fadeInSec: number
  fontSize: number
}

export const DEFAULT_CHAT_OVERLAY_OPTIONS: ChatOverlayOptions = {
  maxLines: 5,
  maxWrapLines: 2,
  fadeInSec: 0.15,
  fontSize: 34
}

/** Calm, muted colours, stable per user (no colours in this chat format). */
const USER_COLORS = ['#8AB4F8', '#F28B82', '#FBBC04', '#81C995', '#C58AF9', '#78D9EC', '#F6AEA9', '#B5C7A9']

function hashString(s: string): number {
  let h = 0
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0
  return h
}

/** A calm, stable colour for a user name, picked from a small palette. */
export function colorForUser(user: string): string {
  return USER_COLORS[hashString(user.toLowerCase()) % USER_COLORS.length]!
}

/** Messages inside [from, to), VOD seconds. */
export function chatIn(messages: ChatMessage[], from: number, to: number): ChatMessage[] {
  return messages.filter((m) => m.t >= from && m.t < to)
}

/**
 * Word-wraps `text` to at most `maxLines` lines of `maxChars` characters,
 * truncating with "..." if it still does not fit.
 */
export function wrapChatText(text: string, maxChars: number, maxLines: number): string[] {
  const chars = Math.max(4, maxChars)
  const words = text.trim().replace(/\s+/g, ' ').split(' ').filter(Boolean)
  if (words.length === 0) return ['']

  const lines: string[] = []
  let cur = ''
  let idx = 0
  while (idx < words.length && lines.length < maxLines) {
    const raw = words[idx]!
    const word = raw.length > chars ? raw.slice(0, chars) : raw
    const candidate = cur ? `${cur} ${word}` : word
    if (candidate.length <= chars) {
      cur = candidate
      idx++
      continue
    }
    if (!cur) {
      lines.push(word)
      idx++
      continue
    }
    lines.push(cur)
    cur = ''
  }
  if (lines.length < maxLines && cur) {
    lines.push(cur)
    cur = ''
  }

  const truncated = idx < words.length || cur.length > 0
  if (truncated && lines.length > 0) {
    const lastIdx = lines.length - 1
    const room = Math.max(1, chars - 4)
    lines[lastIdx] = `${lines[lastIdx]!.slice(0, room).trimEnd()} ...`
  }
  return lines
}

export interface ChatOverlayGeometry {
  /** Pixel box on the OUTPUT canvas (post-crop, same space the captions use). */
  x: number
  y: number
  w: number
  h: number
  align: 'left' | 'right'
  lineHeight: number
  /** Reserved vertical space per message (fits up to `maxWrapLines` lines). */
  slotHeight: number
  /** How many messages fit in the box without crowding the layout. */
  maxLines: number
  maxCharsPerLine: number
}

/**
 * Where the chat box goes for this format/layout: below the facecam when
 * there is one, above the caption band, anchored to a corner so it never
 * fights for the centre of the frame. `pos`, when he dragged the box
 * somewhere, is its top-left corner (fractions of the output frame) and
 * replaces that default place; the box keeps its full size then, since he
 * chose the spot and the caption band no longer shortens it.
 */
export function chatOverlayGeometry(
  format: RenderFormat,
  layout: Layout,
  source: Size,
  captionY: number | null,
  opts: ChatOverlayOptions = DEFAULT_CHAT_OVERLAY_OPTIONS,
  pos: NormPos | null = null
): ChatOverlayGeometry {
  const out = OUTPUT_SIZE[format]
  const marginX = Math.round(out.width * 0.045)
  const marginY = Math.round(out.height * 0.035)

  let top = marginY
  if (format === 'vertical') {
    const g = verticalGeometry(layout, source)
    if (g.cam) top = g.camHeight + marginY
  }

  const lineHeight = Math.round(opts.fontSize * 1.3)
  const slotHeight = lineHeight * opts.maxWrapLines
  const maxBoxHeight = Math.round(out.height * (format === 'vertical' ? 0.34 : 0.4))
  let bottom = top + Math.min(maxBoxHeight, slotHeight * opts.maxLines)
  if (captionY !== null && !pos) {
    const capTop = out.height * Math.max(0, captionY - 0.14)
    bottom = Math.min(bottom, Math.max(top + slotHeight, capTop - marginY))
  }
  const height = Math.max(slotHeight, Math.round(bottom - top))
  const maxLines = Math.max(1, Math.min(opts.maxLines, Math.floor(height / slotHeight)))

  const width = Math.round(out.width * (format === 'vertical' ? 0.5 : 0.32))
  let x = out.width - width - marginX
  let y = top
  if (pos) {
    const at = clampBoxPos(pos, { w: width / out.width, h: height / out.height })
    x = Math.round(at.x * out.width)
    y = Math.round(at.y * out.height)
  }
  const charWidth = opts.fontSize * 0.52
  const maxCharsPerLine = Math.max(10, Math.floor((width - marginX) / charWidth))

  return { x, y, w: width, h: height, align: 'right', lineHeight, slotHeight, maxLines, maxCharsPerLine }
}

/** The chat box's top-left corner and size as fractions of the output frame. */
export function chatBoxNorm(g: Pick<ChatOverlayGeometry, 'x' | 'y' | 'w' | 'h'>, format: RenderFormat): { x: number; y: number; w: number; h: number } {
  const out = OUTPUT_SIZE[format]
  return { x: g.x / out.width, y: g.y / out.height, w: g.w / out.width, h: g.h / out.height }
}

/** His saved chat position for a format, or null for the default place. */
export function chatPosition(saved: FormatPositions | undefined, format: RenderFormat): NormPos | null {
  return saved?.[format] ?? null
}

/** The saved positions after the chat box was placed at `pos` for `format`. */
export function withChatPosition(saved: FormatPositions | undefined, format: RenderFormat, pos: NormPos): FormatPositions {
  return { ...saved, [format]: { x: roundNorm(pos.x), y: roundNorm(pos.y) } }
}

/** The saved positions with one format back on the default place (empty when none is left). */
export function resetChatPosition(saved: FormatPositions | undefined, format: RenderFormat): FormatPositions {
  const next = { ...saved }
  delete next[format]
  return next
}

/**
 * Moves the chat box to `pos` (its top-left corner, already where the pointer
 * is): keeps the whole box in the frame and, unless `snap` is off, snaps its
 * edges to the platform safe area and its centre to the middle of the frame,
 * and the box to its default place. `guideX`/`guideY` are the frame lines
 * that lined up, for drawing.
 */
export function placeChatBox(
  pos: NormPos,
  box: { w: number; h: number },
  format: RenderFormat,
  home: NormPos,
  opts: { snap?: boolean } = {}
): { pos: NormPos; guideX: number | null; guideY: number | null } {
  const clamped = clampBoxPos(pos, box)
  if (opts.snap === false) return { pos: clamped, guideX: null, guideY: null }
  const area = safeArea(format)
  const sx = snapAxisHome(clamped.x, { at: home.x, guide: home.x }, boxSnapTargets(box.w, [area.left, area.right]))
  const sy = snapAxisHome(clamped.y, { at: home.y, guide: home.y }, boxSnapTargets(box.h, [area.top, area.bottom]))
  return { pos: clampBoxPos({ x: sx.value, y: sy.value }, box), guideX: sx.guide, guideY: sy.guide }
}

export interface ChatOverlayLine {
  /** ASS-ready body: escaped, name coloured, message wrapped with hard breaks. */
  text: string
  /** The same line's raw fields, for a renderer that draws its own markup (e.g. the review preview). */
  user: string
  /** #RRGGBB, stable per user. */
  color: string
  messageLines: string[]
  x: number
  y: number
  align: 'left' | 'right'
  /** Clip-relative seconds. */
  start: number
  end: number
  /** Fade-in length in milliseconds, or null for no fade. */
  fadeInMs: number | null
}

function formatChatLine(user: string, color: string, messageLines: string[]): string {
  const name = assEscape(user)
  const first = assEscape(messageLines[0] ?? '')
  const rest = messageLines.slice(1).map((l) => assEscape(l))
  const head = `{\\c${color}}${name}{\\c&HFFFFFF&}: ${first}`
  return [head, ...rest].join('\\N')
}

/**
 * Builds the placed, ready-to-draw chat lines for one clip: windows the
 * messages to [clipStart, clipEnd) (VOD seconds), spreads same-second
 * messages evenly, and stacks them newest-at-the-bottom, oldest scrolled off
 * after `geometry.maxLines` more have arrived.
 */
export function buildChatOverlay(
  messages: ChatMessage[],
  clipStart: number,
  clipEnd: number,
  geometry: ChatOverlayGeometry,
  opts: ChatOverlayOptions = DEFAULT_CHAT_OVERLAY_OPTIONS
): ChatOverlayLine[] {
  const duration = clipEnd - clipStart
  if (duration <= 0) return []
  const inRange = chatIn(messages, clipStart, clipEnd)
  if (inRange.length === 0) return []

  const bySecond = new Map<number, ChatMessage[]>()
  for (const m of inRange) {
    const list = bySecond.get(m.t)
    if (list) list.push(m)
    else bySecond.set(m.t, [m])
  }
  const seconds = [...bySecond.keys()].sort((a, b) => a - b)
  const spread: { m: ChatMessage; at: number }[] = []
  for (const sec of seconds) {
    const list = bySecond.get(sec)!
    const n = list.length
    for (let i = 0; i < n; i++) spread.push({ m: list[i]!, at: sec + (i + 0.5) / n })
  }

  interface QueueItem {
    user: string
    color: string
    lines: string[]
  }

  const out: ChatOverlayLine[] = []
  let queue: QueueItem[] = []
  let periodStart = Math.max(0, Math.min(duration, spread[0]!.at - clipStart))

  const flush = (until: number): void => {
    if (until - periodStart < 0.02) return
    const x = geometry.align === 'right' ? geometry.x + geometry.w : geometry.x
    for (let slot = 0; slot < queue.length && slot < geometry.maxLines; slot++) {
      const q = queue[slot]!
      const y = geometry.y + geometry.h - (slot + 1) * geometry.slotHeight
      out.push({
        text: formatChatLine(q.user, inlineColor(q.color), q.lines),
        user: q.user,
        color: q.color,
        messageLines: q.lines,
        x,
        y,
        align: geometry.align,
        start: periodStart,
        end: until,
        fadeInMs: slot === 0 ? Math.round(opts.fadeInSec * 1000) : null
      })
    }
  }

  for (const { m, at } of spread) {
    const relAt = Math.max(0, Math.min(duration, at - clipStart))
    if (relAt > periodStart) flush(relAt)
    const nameBudget = Math.min(m.user.length, 16)
    const msgBudget = Math.max(8, geometry.maxCharsPerLine - nameBudget - 2)
    queue = [{ user: m.user.slice(0, 16), color: colorForUser(m.user), lines: wrapChatText(m.text, msgBudget, opts.maxWrapLines) }, ...queue].slice(
      0,
      geometry.maxLines
    )
    periodStart = relAt
  }
  flush(duration)
  return out
}
