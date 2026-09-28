// yt-dlp: VOD metadata, audio-only download and clip section downloads.

import { dirname } from 'node:path'
import type { VodInfo } from '@shared/types'
import { UserError } from '../util/errors'
import { runTool, ToolFailedError } from '../tools/process'

export interface VodMeta {
  info: VodInfo
  chapters: { start: number; end: number; title: string }[]
  audioPlaylistUrl: string | null
  isLive: boolean
}

const COMMON = ['--ignore-config', '--no-playlist', '--encoding', 'utf-8', '--no-colors', '--retries', '10', '--fragment-retries', '10', '--socket-timeout', '30']

const ENV = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }

/** Turns yt-dlp's error output into one plain sentence. */
export function ytdlpError(err: unknown): UserError {
  const text = err instanceof ToolFailedError ? err.stderrTail : err instanceof Error ? err.message : String(err)
  const t = text.toLowerCase()
  if (t.includes('does not exist') || t.includes('http error 404')) return new UserError('That VOD does not exist or was deleted.', { cause: err, retryable: false })
  if (t.includes('subscriber')) return new UserError('That VOD is for subscribers only. CrapCut only works with public VODs.', { cause: err, retryable: false })
  if (t.includes('private') || t.includes('login') || t.includes('log in')) return new UserError('That VOD is not public.', { cause: err, retryable: false })
  if (t.includes('http error 403') || t.includes('forbidden')) return new UserError('Twitch refused the download. Try again in a few minutes.', { cause: err })
  if (t.includes('getaddrinfo') || t.includes('unable to download') || t.includes('timed out') || t.includes('connection'))
    return new UserError('Could not reach Twitch. Check your internet connection.', { cause: err })
  if (t.includes('no space left') || t.includes('errno 28')) return new UserError('The disk is full. Free some space and try again.', { cause: err })
  return new UserError('Downloading from Twitch failed. Try again in a few minutes.', { cause: err })
}

/** Same idea as `ytdlpError`, worded for checking a channel rather than a VOD. */
export function channelYtdlpError(channel: string, err: unknown): UserError {
  const text = err instanceof ToolFailedError ? err.stderrTail : err instanceof Error ? err.message : String(err)
  const t = text.toLowerCase()
  if (t.includes('does not exist') || t.includes('http error 404')) return new UserError(`No channel named "${channel}" was found.`, { cause: err, retryable: false })
  if (t.includes('getaddrinfo') || t.includes('unable to download') || t.includes('timed out') || t.includes('connection'))
    return new UserError('Could not reach Twitch. Check your internet connection.', { cause: err })
  return new UserError(`Could not check ${channel} for new VODs.`, { cause: err })
}

interface RawInfo {
  id?: string
  title?: string
  uploader?: string
  uploader_id?: string
  duration?: number
  timestamp?: number
  thumbnail?: string
  is_live?: boolean
  live_status?: string
  chapters?: { start_time?: number; end_time?: number; title?: string }[]
  formats?: { format_id?: string; url?: string; vcodec?: string; acodec?: string; protocol?: string }[]
}

export function parseVodJson(json: string, vodId: string): VodMeta {
  const raw = JSON.parse(json) as RawInfo
  const duration = Number(raw.duration)
  if (!Number.isFinite(duration) || duration <= 0) throw new UserError('Could not read the length of that VOD.', { retryable: false })
  const audio = raw.formats?.find((f) => f.format_id?.toLowerCase() === 'audio_only') ?? raw.formats?.find((f) => f.vcodec === 'none' && f.acodec && f.acodec !== 'none')
  return {
    info: {
      id: vodId,
      title: (raw.title ?? 'Untitled stream').slice(0, 300),
      channel: (raw.uploader ?? raw.uploader_id ?? 'Unknown').slice(0, 100),
      durationSec: duration,
      createdAt: raw.timestamp ? new Date(raw.timestamp * 1000).toISOString() : null,
      thumbnailUrl: raw.thumbnail && /^https:\/\/[\w.-]+\.(jtvnw\.net|cloudfront\.net|twitch\.tv)\//.test(raw.thumbnail) ? raw.thumbnail : null
    },
    chapters: (raw.chapters ?? [])
      .filter((c) => Number.isFinite(c.start_time) && Number.isFinite(c.end_time))
      .map((c) => ({ start: c.start_time!, end: c.end_time!, title: (c.title ?? '').slice(0, 100) })),
    audioPlaylistUrl: audio?.url && audio.url.startsWith('https://') ? audio.url : null,
    isLive: raw.is_live === true || raw.live_status === 'is_live'
  }
}

export async function fetchVodMeta(ytdlp: string, url: string, vodId: string, signal: AbortSignal): Promise<VodMeta> {
  try {
    const { stdout } = await runTool(ytdlp, [...COMMON, '-J', '--no-warnings', url], { signal, env: ENV, timeoutMs: 120_000, keepBytes: 8 * 1024 * 1024 })
    return parseVodJson(stdout, vodId)
  } catch (err) {
    if (err instanceof UserError) throw err
    if (err instanceof Error && err.name === 'CancelledError') throw err
    throw ytdlpError(err)
  }
}

/** The channel's archived-VOD listing, newest first. */
export function channelVideosUrl(channel: string): string {
  return `https://www.twitch.tv/${channel}/videos?filter=archives&sort=time`
}

/**
 * Raw JSON of a channel's recent VODs, for `core/channelVideos.ts` to parse.
 * Flat-playlist mode skips each video's own page, so this is fast enough to
 * poll on a schedule.
 */
export async function fetchChannelVideos(ytdlp: string, channel: string, signal: AbortSignal, limit = 20): Promise<string> {
  try {
    const { stdout } = await runTool(
      ytdlp,
      ['--ignore-config', '--encoding', 'utf-8', '--no-colors', '--retries', '5', '--socket-timeout', '30', '--flat-playlist', '--no-warnings', '--playlist-end', String(limit), '-J', channelVideosUrl(channel)],
      { signal, env: ENV, timeoutMs: 60_000, keepBytes: 4 * 1024 * 1024 }
    )
    return stdout
  } catch (err) {
    if (err instanceof Error && err.name === 'CancelledError') throw err
    throw channelYtdlpError(channel, err)
  }
}

/**
 * Whether the channel is live right now. A channel's own page is the
 * "twitch:stream" extractor: it succeeds with `is_live: true` while live,
 * and fails with "The channel is not currently live" otherwise. Used to
 * hold back an in-progress stream's own (still growing) VOD from the watch.
 */
export async function fetchChannelIsLive(ytdlp: string, channel: string, signal: AbortSignal): Promise<boolean> {
  try {
    const { stdout } = await runTool(ytdlp, ['--ignore-config', '--encoding', 'utf-8', '--no-colors', '--retries', '5', '--socket-timeout', '30', '--no-warnings', '-J', `https://www.twitch.tv/${channel}`], {
      signal,
      env: ENV,
      timeoutMs: 60_000,
      keepBytes: 512 * 1024
    })
    const raw = JSON.parse(stdout) as { is_live?: boolean; live_status?: string }
    return raw.is_live === true || raw.live_status === 'is_live'
  } catch (err) {
    if (err instanceof Error && err.name === 'CancelledError') throw err
    const text = err instanceof ToolFailedError ? err.stderrTail : err instanceof Error ? err.message : String(err)
    if (/not currently live/i.test(text)) return false
    throw channelYtdlpError(channel, err)
  }
}

/** Parses our --progress-template line: "CC <done> <total> <estimate> <frag> <frags>". */
export function parseYtdlpProgress(line: string): number | null {
  const m = /^CC (\S+) (\S+) (\S+) (\S+) (\S+)/.exec(line)
  if (!m) return null
  const n = (s: string): number | null => (s === 'NA' || s === 'None' ? null : Number(s))
  const done = n(m[1]!)
  const total = n(m[2]!) ?? n(m[3]!)
  const frag = n(m[4]!)
  const frags = n(m[5]!)
  if (frag !== null && frags) return Math.min(1, frag / frags)
  if (done !== null && total) return Math.min(1, done / total)
  return null
}

const PROGRESS = ['--newline', '--progress', '--progress-template', 'download:CC %(progress.downloaded_bytes)s %(progress.total_bytes)s %(progress.total_bytes_estimate)s %(progress.fragment_index)s %(progress.fragment_count)s']

/** Downloads the audio-only rendition. Resumes partial downloads. */
export async function downloadAudio(
  ytdlp: string,
  ffmpeg: string,
  url: string,
  outTemplate: string,
  signal: AbortSignal,
  onProgress: (f: number) => void
): Promise<void> {
  try {
    await runTool(
      ytdlp,
      [
        ...COMMON,
        ...PROGRESS,
        '-f',
        'Audio_Only/bestaudio/worst',
        '-N',
        '8',
        '--continue',
        '--no-mtime',
        '--ffmpeg-location',
        dirname(ffmpeg),
        '-o',
        outTemplate,
        url
      ],
      {
        signal,
        env: ENV,
        onStdout: (line) => {
          const f = parseYtdlpProgress(line)
          if (f !== null) onProgress(f)
        }
      }
    )
  } catch (err) {
    if (err instanceof Error && err.name === 'CancelledError') throw err
    throw ytdlpError(err)
  }
}

/** Downloads [start, end] of the VOD video (1080p at most). */
export async function downloadSection(
  ytdlp: string,
  ffmpeg: string,
  url: string,
  start: number,
  end: number,
  outTemplate: string,
  signal: AbortSignal,
  onProgress: (f: number) => void
): Promise<void> {
  try {
    await runTool(
      ytdlp,
      [
        ...COMMON,
        ...PROGRESS,
        '-f',
        'best[height<=1080][fps<=60]/best[height<=1080]/best',
        '--download-sections',
        `*${start.toFixed(2)}-${end.toFixed(2)}`,
        '--no-mtime',
        '--force-overwrites',
        '--ffmpeg-location',
        dirname(ffmpeg),
        '--merge-output-format',
        'mp4',
        '-o',
        outTemplate,
        url
      ],
      {
        signal,
        env: ENV,
        onStdout: (line) => {
          const f = parseYtdlpProgress(line)
          if (f !== null) onProgress(f)
        },
        // Section downloads go through FFmpeg; its time= output shows progress.
        onStderr: (line) => {
          const m = /time=(\d+):(\d+):([\d.]+)/.exec(line)
          if (m) onProgress(Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / Math.max(1, end - start)))
        }
      }
    )
  } catch (err) {
    if (err instanceof Error && err.name === 'CancelledError') throw err
    throw ytdlpError(err)
  }
}
