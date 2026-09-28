// Pure logic for the channel-watch feature: reading yt-dlp's flat-playlist
// listing of a channel's VODs, and deciding which ones are new since the
// watch was turned on.
//
// The pinned yt-dlp's flat-playlist entries for a Twitch channel are sparse:
// only `id` (with a leading "v", e.g. "v2885598325") and `duration` are
// reliably present. There is no publish time and no live flag. So "new" is
// decided by VOD id, not by time: Twitch VOD ids only ever increase, so the
// id seen when the watch is turned on (or, if that first fetch failed, the
// first one after) is kept as a baseline, and anything with a strictly
// greater id is new.

export interface ChannelVod {
  id: string
  title: string
  durationSec: number | null
  /** Epoch ms, only on the rare listing that happens to report it. */
  publishedAt: number | null
  /** True only when yt-dlp explicitly flags the entry itself as live. */
  isLive: boolean
}

interface RawEntry {
  id?: string
  title?: string
  duration?: number
  timestamp?: number
  release_timestamp?: number
  upload_date?: string
  is_live?: boolean
  live_status?: string
}

/** Twitch VOD ids come back as "v<digits>" from the flat-playlist listing. */
function parseId(raw: string | undefined): string | null {
  if (!raw) return null
  const m = /^v?(\d{1,15})$/.exec(raw)
  return m ? m[1]! : null
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
    const id = parseId(e.id)
    if (!id) continue
    out.push({
      id,
      title: (e.title ?? 'Untitled stream').slice(0, 300),
      durationSec: typeof e.duration === 'number' && Number.isFinite(e.duration) ? e.duration : null,
      publishedAt: entryPublishedAt(e),
      isLive: e.is_live === true || e.live_status === 'is_live'
    })
  }
  return out
}

/** Compares two numeric VOD id strings. Twitch VOD ids only ever increase. */
export function compareVodId(a: string, b: string): number {
  const x = BigInt(a)
  const y = BigInt(b)
  return x < y ? -1 : x > y ? 1 : 0
}

/** The greatest VOD id in the listing, or null when it is empty. */
export function newestVodId(vods: ChannelVod[]): string | null {
  let newest: string | null = null
  for (const v of vods) if (newest === null || compareVodId(v.id, newest) > 0) newest = v.id
  return newest
}

/**
 * Which VODs to queue: a strictly greater id than the baseline (so never
 * anything from before the watch started, and each VOD only once), not
 * flagged live, and not already a job. Oldest first, so clips come back in
 * the order the streams happened. Returns nothing until a baseline exists.
 */
export function selectNewVods(vods: ChannelVod[], baselineId: string | null, hasJob: (vodId: string) => boolean): ChannelVod[] {
  if (baselineId === null) return []
  return vods.filter((v) => !v.isLive && compareVodId(v.id, baselineId) > 0 && !hasJob(v.id)).sort((a, b) => compareVodId(a.id, b.id))
}

/**
 * Drops the newest of a list of candidate VODs. Used to hold back the
 * in-progress stream's own (still growing) VOD entry while the channel is
 * live, since it is not finished yet.
 */
export function withoutNewest(vods: ChannelVod[]): ChannelVod[] {
  const newest = newestVodId(vods)
  return newest === null ? vods : vods.filter((v) => v.id !== newest)
}
