// Pure logic for the channel-watch feature: reading yt-dlp's flat-playlist
// listing of a channel's VODs, and deciding which ones are new since the
// watch was turned on.

export interface ChannelVod {
  id: string
  title: string
  /** Epoch ms the VOD was published, when yt-dlp reports it; null if unknown. */
  publishedAt: number | null
  isLive: boolean
}

interface RawEntry {
  id?: string
  title?: string
  timestamp?: number
  release_timestamp?: number
  upload_date?: string
  is_live?: boolean
  live_status?: string
  was_live?: boolean
}

function entryPublishedAt(e: RawEntry): number | null {
  const ts = e.timestamp ?? e.release_timestamp
  if (typeof ts === 'number' && Number.isFinite(ts)) return Math.round(ts * 1000)
  if (e.upload_date && /^\d{8}$/.test(e.upload_date)) {
    const y = Number(e.upload_date.slice(0, 4))
    const m = Number(e.upload_date.slice(4, 6))
    const d = Number(e.upload_date.slice(6, 8))
    const ms = Date.UTC(y, m - 1, d)
    return Number.isFinite(ms) ? ms : null
  }
  return null
}

/** Parses `yt-dlp -J --flat-playlist` output for a channel's video listing. */
export function parseChannelVideos(json: string): ChannelVod[] {
  let raw: unknown
  try {
    raw = JSON.parse(json)
  } catch {
    return []
  }
  const entries = raw && typeof raw === 'object' && Array.isArray((raw as { entries?: unknown }).entries) ? ((raw as { entries: RawEntry[] }).entries as RawEntry[]) : []
  const out: ChannelVod[] = []
  for (const e of entries) {
    if (!e.id || !/^\d{1,15}$/.test(e.id)) continue
    out.push({
      id: e.id,
      title: (e.title ?? 'Untitled stream').slice(0, 300),
      publishedAt: entryPublishedAt(e),
      isLive: e.is_live === true || e.live_status === 'is_live' || e.was_live === true
    })
  }
  return out
}

/**
 * Which VODs to queue: published strictly after the watch was turned on, not
 * still live, and not already a job. A VOD with no known publish time is
 * skipped rather than guessed at, so the channel's history is never
 * back-filled. Oldest first, so clips come back in the order the streams
 * happened.
 */
export function selectNewVods(vods: ChannelVod[], enabledAt: number, hasJob: (vodId: string) => boolean): ChannelVod[] {
  return vods
    .filter((v) => !v.isLive && v.publishedAt !== null && v.publishedAt > enabledAt && !hasJob(v.id))
    .sort((a, b) => (a.publishedAt ?? 0) - (b.publishedAt ?? 0))
}
