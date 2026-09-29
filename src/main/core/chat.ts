// Parses TwitchDownloaderCLI's .txt chat log ("[H:MM:SS] user: message", relative
// timestamps) into compact messages. Streaming-friendly: one line at a time.

import type { ChatMessage } from '@shared/types'

export type { ChatMessage }

const LINE = /^\[(\d+):(\d{2}):(\d{2})\]\s+([^:\s][^:]*?):\s?(.*)$/

/** Well-known chat bots; their messages are not audience reactions. */
const BOTS = new Set([
  'nightbot',
  'streamelements',
  'streamlabs',
  'moobot',
  'fossabot',
  'wizebot',
  'botisimo',
  'sery_bot',
  'soundalerts',
  'pokemoncommunitygame',
  'kofistreambot',
  'tangiabot',
  'blerp',
  'commanderroot',
  'streamstickers'
])

export function parseChatLine(line: string): ChatMessage | null {
  const m = LINE.exec(line.trimEnd())
  if (!m) return null
  const t = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])
  const user = (m[4] as string).trim()
  if (!user || user.length > 40) return null
  return { t, user, text: m[5] as string }
}

export function isBot(user: string): boolean {
  const u = user.toLowerCase()
  return BOTS.has(u)
}

/** Parses a whole chat log. Bots and malformed lines are dropped. */
export function parseChatLog(text: string): ChatMessage[] {
  const out: ChatMessage[] = []
  for (const line of text.split(/\r?\n/)) {
    const msg = parseChatLine(line)
    if (msg && !isBot(msg.user)) out.push(msg)
  }
  return out
}
