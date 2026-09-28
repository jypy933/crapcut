// Caption look presets: a few ready-made looks in the style of TikTok/Shorts/
// Reels captions. Every preset uses the same word-by-word timing (see
// shared/captions.ts); only how each word looks on screen changes. Shared by
// the review preview (renderer) and the ASS burn-in (main).

export const CAPTION_STYLE_IDS = ['clean', 'bold', 'boxed', 'minimal'] as const
export type CaptionStyleId = (typeof CAPTION_STYLE_IDS)[number]

export interface CaptionStyle {
  id: CaptionStyleId
  label: string
  /** Font family passed to libass. Free to redistribute or already on Windows. */
  fontName: string
  /** CSS font-family stack the preview uses to match it. */
  cssFontFamily: string
  textColor: string
  highlightColor: string
  /** Multiplies the format's base outline width. */
  outlineScale: number
  /** Multiplies the format's base shadow size. */
  shadowScale: number
  /** An opaque box behind the line instead of a per-letter outline. */
  box: boolean
  /** The spoken word grows in briefly when a new line appears. */
  pop: boolean
  /** Shouted words, numbers and ALL CAPS words get the highlight colour too. */
  emphasizeKeywords: boolean
}

export const CAPTION_STYLES: readonly CaptionStyle[] = [
  {
    id: 'clean',
    label: 'Clean',
    fontName: 'Montserrat Black',
    cssFontFamily: '"Caption", "Segoe UI", sans-serif',
    textColor: '#FFFFFF',
    highlightColor: '#FFD400',
    outlineScale: 1,
    shadowScale: 1,
    box: false,
    pop: true,
    emphasizeKeywords: false
  },
  {
    id: 'bold',
    label: 'Bold pop',
    fontName: 'Arial Black',
    cssFontFamily: '"Arial Black", Arial, sans-serif',
    textColor: '#FFFFFF',
    highlightColor: '#39FF14',
    outlineScale: 1.3,
    shadowScale: 1,
    box: false,
    pop: true,
    emphasizeKeywords: true
  },
  {
    id: 'boxed',
    label: 'Boxed',
    fontName: 'Montserrat Black',
    cssFontFamily: '"Caption", "Segoe UI", sans-serif',
    textColor: '#FFFFFF',
    highlightColor: '#FFD400',
    outlineScale: 2.6,
    shadowScale: 0,
    box: true,
    pop: false,
    emphasizeKeywords: false
  },
  {
    id: 'minimal',
    label: 'Minimal',
    fontName: 'Segoe UI',
    cssFontFamily: '"Segoe UI", sans-serif',
    textColor: '#FFFFFF',
    highlightColor: '#FFFFFF',
    outlineScale: 0.35,
    shadowScale: 0.5,
    box: false,
    pop: false,
    emphasizeKeywords: false
  }
]

export const DEFAULT_CAPTION_STYLE: CaptionStyleId = 'clean'

export function captionStyle(id: string | null | undefined): CaptionStyle {
  return CAPTION_STYLES.find((s) => s.id === id) ?? CAPTION_STYLES[0]!
}

export function isCaptionStyleId(id: string): id is CaptionStyleId {
  return (CAPTION_STYLE_IDS as readonly string[]).includes(id)
}
