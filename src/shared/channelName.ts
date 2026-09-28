// Validates a channel entered once for the watch feature. Accepts a plain
// name, an "@name", or a channel link like twitch.tv/name.

export type ChannelNameResult = { ok: true; channel: string } | { ok: false; reason: string }

const HOSTS = new Set(['twitch.tv', 'www.twitch.tv', 'm.twitch.tv'])
const NAME_RE = /^[a-z0-9][a-z0-9_]{3,24}$/i
const MAX_LENGTH = 200
// Path segments on twitch.tv that are not channel names.
const RESERVED = new Set(['videos', 'directory', 'settings', 'subscriptions', 'friends', 'p', 'clips', 'moderator', 'admin', 'downloads', 'jobs'])

export function parseChannelName(input: string): ChannelNameResult {
  let text = input.trim()
  if (text.length === 0) return { ok: false, reason: 'Enter a channel name first.' }
  if (text.length > MAX_LENGTH) return { ok: false, reason: 'That does not look like a channel name.' }

  const looksLikeLink = /^[a-z][a-z0-9+.-]*:\/\//i.test(text) || /^(www\.|m\.)?twitch\.tv\//i.test(text)
  if (looksLikeLink) {
    let url: URL
    try {
      url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : `https://${text}`)
    } catch {
      return { ok: false, reason: 'That does not look like a channel link.' }
    }
    if (!HOSTS.has(url.hostname.toLowerCase())) return { ok: false, reason: 'Only Twitch channel links work, like twitch.tv/channel.' }
    const segment = url.pathname.split('/').filter(Boolean)[0]
    if (!segment) return { ok: false, reason: 'That link does not point to a channel.' }
    text = segment
  }

  text = text.replace(/^@/, '')
  const channel = text.toLowerCase()
  if (!NAME_RE.test(channel)) return { ok: false, reason: 'Channel names are 4-25 letters, numbers or underscores.' }
  if (RESERVED.has(channel)) return { ok: false, reason: 'That is not a channel name.' }
  return { ok: true, channel }
}
