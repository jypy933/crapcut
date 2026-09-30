// Builds an ASS subtitle file with word-by-word highlighted captions for
// FFmpeg's `ass` filter (libass).

import { assColor, assEscape, inlineColor } from '@shared/assText'
import { clampCaptionY } from '@shared/captionPlacement'
import { pickEmphasis } from '@shared/captionEmphasis'
import { displayText, groupWords } from '@shared/captions'
import { CAPTION_STYLES, type CaptionStyle } from '@shared/captionStyles'
import type { ChatOverlayLine } from '@shared/chatOverlay'
import { toOutputPixels } from '@shared/overlayPosition'
import type { Word } from '@shared/types'

export { assColor, assEscape, inlineColor }

export interface AssStyle {
  width: number
  height: number
  fontName: string
  fontSize: number
  outline: number
  shadow: number
  /** Vertical centre of the caption, 0..1 of the frame height (see `captionY` in shared/captionPlacement.ts). */
  y: number
  uppercase: boolean
  /** #RRGGBB */
  textColor: string
  highlightColor: string
  /** An opaque box behind the line instead of a per-letter outline. */
  box: boolean
  /** The spoken word grows in briefly when a new line appears. */
  pop: boolean
  /** The key word picked by `pickEmphasis` waits in this colour instead of the text colour. */
  emphasisColor: string
  /** And is this much bigger than the rest of the line (1 for no bump). */
  emphasisScale: number
}

export function defaultAssStyle(format: 'vertical' | 'horizontal', y: number, uppercase: boolean, preset: CaptionStyle = CAPTION_STYLES[0]!): AssStyle {
  const vertical = format === 'vertical'
  return {
    width: vertical ? 1080 : 1920,
    height: vertical ? 1920 : 1080,
    fontName: preset.fontName,
    fontSize: vertical ? 88 : 72,
    outline: (vertical ? 7 : 6) * preset.outlineScale,
    shadow: 3 * preset.shadowScale,
    y,
    uppercase,
    textColor: preset.textColor,
    highlightColor: preset.highlightColor,
    box: preset.box,
    pop: preset.pop,
    emphasisColor: preset.emphasisColor,
    emphasisScale: preset.emphasisScale
  }
}

/** Seconds -> ASS time "H:MM:SS.cc". */
export function assTime(sec: number): string {
  const cs = Math.max(0, Math.round(sec * 100))
  const h = Math.floor(cs / 360000)
  const m = Math.floor((cs % 360000) / 6000)
  const s = Math.floor((cs % 6000) / 100)
  const c = cs % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(c).padStart(2, '0')}`
}

export interface ChatOverlayFont {
  fontName: string
  fontSize: number
}

export interface ChatOverlayAssInput {
  lines: ChatOverlayLine[]
  font: ChatOverlayFont
}

/** Adds the "Chat" style (a calm translucent box per line) to a styles list. */
function chatStyleLine(font: ChatOverlayFont): string {
  const primary = assColor('#FFFFFF')
  const outline = assColor('#000000')
  // A semi-transparent box behind each line (BorderStyle 3), same trick as
  // the "boxed" caption preset; a little padding, no drop shadow.
  const back = assColor('#000000', 0x58)
  return `Style: Chat,${font.fontName},${font.fontSize},${primary},${primary},${outline},${back},0,0,0,0,100,100,0,0,3,8,0,7,6,6,6,1`
}

/** One Dialogue event for a placed chat line; position and alignment come from its layout. */
function chatEventLine(line: ChatOverlayLine): string {
  const an = line.align === 'right' ? 9 : 7
  const fade = line.fadeInMs && line.fadeInMs > 0 ? `\\fad(${line.fadeInMs},0)` : ''
  return `Dialogue: 1,${assTime(line.start)},${assTime(line.end)},Chat,,0,0,0,,{\\an${an}\\pos(${Math.round(line.x)},${Math.round(line.y)})${fade}}${line.text}`
}

/**
 * Words must be relative to the clip start (seconds). Every word gets its own
 * event showing the whole group with that word highlighted; the group's key
 * word (`pickEmphasis`, at most one) also shows in the style's emphasis colour
 * and a little larger.
 *
 * `chat`, when given, adds the chat-overlay lines (already windowed, wrapped
 * and escaped by `shared/chatOverlay.ts`) as a second style/layer in the same
 * file, so a single `ass=` filter burns in both.
 */
export function buildAss(words: Word[], style: AssStyle, chat?: ChatOverlayAssInput): string {
  const primary = assColor(style.textColor)
  const outlineColour = assColor('#000000')
  // BackColour is the shadow colour for a normal outline, or the box fill
  // when the style draws an opaque box (BorderStyle 3).
  const back = assColor('#000000', style.box ? 0x30 : 0x80)
  const highlight = inlineColor(style.highlightColor)
  const normal = inlineColor(style.textColor)
  const emphasisColour = inlineColor(style.emphasisColor)
  const bump = style.emphasisScale !== 1
  /** Size tags for text at `scale` times normal; with `pop` it grows in like the line's own pop. */
  const sizeTags = (scale: number, pop: boolean): string => {
    const pct = (n: number): number => Math.round(n * 100)
    if (!pop) return `\\fscx${pct(scale)}\\fscy${pct(scale)}`
    return `\\fscx${pct(scale * 0.88)}\\fscy${pct(scale * 0.88)}\\t(0,90,\\fscx${pct(scale)}\\fscy${pct(scale)})`
  }
  // The caption block is centred on this point; the preview places it with the same mapping.
  const { x, y } = toOutputPixels({ x: 0.5, y: clampCaptionY(style.y) }, { width: style.width, height: style.height })
  const margin = Math.round(style.width * 0.06)
  const borderStyle = style.box ? 3 : 1

  const styleLines = [`Style: Caption,${style.fontName},${style.fontSize},${primary},${primary},${outlineColour},${back},0,0,0,0,100,100,0,0,${borderStyle},${style.outline},${style.shadow},5,${margin},${margin},0,1`]
  const eventLines: string[] = []

  const groups = groupWords(words)
  const emphasis = pickEmphasis(groups)
  for (const [g, group] of groups.entries()) {
    const texts = group.words.map((w) => assEscape(displayText(w.text, style.uppercase)))
    for (let i = 0; i < group.words.length; i++) {
      const start = i === 0 ? group.start : group.words[i]!.t0
      const end = i < group.words.length - 1 ? group.words[i + 1]!.t0 : group.end
      if (end - start < 0.01) continue
      const popNow = style.pop && i === 0
      const popTag = popNow ? '\\fscx88\\fscy88\\t(0,90,\\fscx100\\fscy100)' : ''
      // The key word keeps its size in every event of its group so the line
      // never shifts; the tags after it undo the bump (and keep the pop).
      const body = texts
        .map((t, j) => {
          if (j === emphasis[g]) {
            const colour = j === i ? highlight : emphasisColour
            if (!bump) return `{\\c${colour}}${t}{\\c${normal}}`
            return `{\\c${colour}${sizeTags(style.emphasisScale, popNow)}}${t}{\\c${normal}${sizeTags(1, popNow)}}`
          }
          return j === i ? `{\\c${highlight}}${t}{\\c${normal}}` : t
        })
        .join(' ')
      eventLines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,{\\an5\\pos(${x},${y})${popTag}}${body}`)
    }
  }

  if (chat && chat.lines.length > 0) {
    styleLines.push(chatStyleLine(chat.font))
    for (const line of chat.lines) eventLines.push(chatEventLine(line))
  }

  const lines = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${style.width}`,
    `PlayResY: ${style.height}`,
    'WrapStyle: 0',
    'ScaledBorderAndShadow: yes',
    'YCbCr Matrix: TV.709',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    ...styleLines,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text',
    ...eventLines
  ]
  return `${lines.join('\n')}\n`
}
