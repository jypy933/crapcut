// Parses a pasted VOD link. Only public Twitch VOD links are accepted:
// https://www.twitch.tv/videos/<id> (www. and m. hosts, optional ?t=).

export type VodUrlResult =
  | { ok: true; id: string; url: string; startAtSec: number | null }
  | { ok: false; reason: string }

const HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'])
const MAX_LENGTH = 300

export function parseVodUrl(input: string): VodUrlResult {
  const text = input.trim()
  if (text.length === 0) return { ok: false, reason: 'Paste a VOD link first.' }
  if (text.length > MAX_LENGTH) return { ok: false, reason: 'That link is too long to be a VOD link.' }

  let url: URL
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
  } catch {
    return { ok: false, reason: 'That does not look like a link.' }
  }

  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return { ok: false, reason: 'That does not look like a web link.' }
  }
  if (url.username || url.password || url.port) {
    return { ok: false, reason: 'That link is not a normal Twitch VOD link.' }
  }
  if (!HOSTS.has(url.hostname.toLowerCase())) {
    return { ok: false, reason: 'Only Twitch VOD links work, like twitch.tv/videos/123456789.' }
  }

  const match = /^\/videos\/(\d{1,15})\/?$/.exec(url.pathname)
  if (!match) {
    return { ok: false, reason: 'That is not a VOD link. It should look like twitch.tv/videos/123456789.' }
  }
  const id = match[1] as string
  return {
    ok: true,
    id,
    url: `https://www.twitch.tv/videos/${id}`,
    startAtSec: parseTwitchTime(url.searchParams.get('t'))
  }
}

/** Parses Twitch's `t` parameter, e.g. "1h2m3s" or "93s". */
export function parseTwitchTime(value: string | null): number | null {
  if (!value) return null
  const m = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?$/.exec(value)
  if (!m || (!m[1] && !m[2] && !m[3])) return null
  return Number(m[1] ?? 0) * 3600 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0)
}
