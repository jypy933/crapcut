// Builds an ASS subtitle file with word-by-word highlighted captions for
// FFmpeg's `ass` filter (libass).

import { displayText, groupWords, isKeywordWord } from '@shared/captions'
import { CAPTION_STYLES, type CaptionStyle } from '@shared/captionStyles'
import type { Word } from '@shared/types'

export interface AssStyle {
  width: number
  height: number
  fontName: string
  fontSize: number
  outline: number
  shadow: number
  /** Vertical centre of the caption, 0..1 of the frame height. */
  y: number
  uppercase: boolean
  /** #RRGGBB */
  textColor: string
  highlightColor: string
  /** An opaque box behind the line instead of a per-letter outline. */
  box: boolean
  /** The spoken word grows in briefly when a new line appears. */
  pop: boolean
  /** Shouted words, numbers and ALL CAPS words get the highlight colour too. */
  emphasizeKeywords: boolean
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
    emphasizeKeywords: preset.emphasizeKeywords
  }
}

/** #RRGGBB -> ASS &HAABBGGRR (alpha 00 = opaque). */
export function assColor(hex: string, alpha = 0): string {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex)
  if (!m) throw new Error(`bad colour ${hex}`)
  const a = alpha.toString(16).padStart(2, '0')
  return `&H${a}${m[3]}${m[2]}${m[1]}`.toUpperCase()
}

/** #RRGGBB -> inline override colour "&HBBGGRR&". */
export function inlineColor(hex: string): string {
  return `${assColor(hex).replace(/^&H00/, '&H')}&`
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

/** Makes user text safe inside an ASS Dialogue line (no override tags, no breaks). */
export function assEscape(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '/')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
}

/**
 * Words must be relative to the clip start (seconds). Every word gets its own
 * event showing the whole group with that word highlighted; a style with
 * keyword emphasis also highlights shouted/number words while they wait.
 */
export function buildAss(words: Word[], style: AssStyle): string {
  const primary = assColor(style.textColor)
  const outlineColour = assColor('#000000')
  // BackColour is the shadow colour for a normal outline, or the box fill
  // when the style draws an opaque box (BorderStyle 3).
  const back = assColor('#000000', style.box ? 0x30 : 0x80)
  const highlight = inlineColor(style.highlightColor)
  const normal = inlineColor(style.textColor)
  const x = Math.round(style.width / 2)
  const y = Math.round(Math.max(0.05, Math.min(0.95, style.y)) * style.height)
  const margin = Math.round(style.width * 0.06)
  const borderStyle = style.box ? 3 : 1

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
    `Style: Caption,${style.fontName},${style.fontSize},${primary},${primary},${outlineColour},${back},0,0,0,0,100,100,0,0,${borderStyle},${style.outline},${style.shadow},5,${margin},${margin},0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ]

  for (const group of groupWords(words)) {
    const texts = group.words.map((w) => assEscape(displayText(w.text, style.uppercase)))
    for (let i = 0; i < group.words.length; i++) {
      const start = i === 0 ? group.start : group.words[i]!.t0
      const end = i < group.words.length - 1 ? group.words[i + 1]!.t0 : group.end
      if (end - start < 0.01) continue
      const popTag = style.pop && i === 0 ? '\\fscx88\\fscy88\\t(0,90,\\fscx100\\fscy100)' : ''
      const body = texts
        .map((t, j) => {
          const emphasised = j === i || (style.emphasizeKeywords && isKeywordWord(group.words[j]!.text))
          return emphasised ? `{\\c${highlight}}${t}{\\c${normal}}` : t
        })
        .join(' ')
      lines.push(`Dialogue: 0,${assTime(start)},${assTime(end)},Caption,,0,0,0,,{\\an5\\pos(${x},${y})${popTag}}${body}`)
    }
  }
  return `${lines.join('\n')}\n`
}
