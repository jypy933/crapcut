// Small text/colour helpers for building ASS subtitle files. Shared because
// both the burn-in (core/ass.ts) and the pure chat-overlay layout
// (shared/chatOverlay.ts) need to produce identical, safe ASS text.

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

/** Makes user text safe inside an ASS Dialogue line (no override tags, no breaks). */
export function assEscape(text: string): string {
  return text
    .replace(/[\r\n]+/g, ' ')
    .replace(/\\/g, '/')
    .replace(/\{/g, '(')
    .replace(/\}/g, ')')
}
