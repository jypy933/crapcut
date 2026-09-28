// The whole IPC surface between the sandboxed UI and the main process.
// Every request is validated with these schemas in main before it is used.

import { z } from 'zod'
import type { AppInfo, ChannelWatchStatus, Clip, ExportItem, JobSummary, Layout, SetupStatus, UpdateState } from './types'
import { AUDIO_MODES } from './types'
import { EVENT_CHANNELS, type INVOKE_CHANNELS } from './channels'

export { EVENT_CHANNELS }

const id = z.string().regex(/^[a-z0-9-]{6,64}$/i)
const unit = z.number().finite().min(0).max(1)
const seconds = z.number().finite().min(0).max(48 * 3600)

export const RectSchema = z.object({ x: unit, y: unit, w: unit.min(0.01), h: unit.min(0.01) }).strict()

export const LayoutSchema = z
  .object({
    id,
    name: z.string().trim().min(1).max(40),
    kind: z.enum(['cam_game', 'blur_fill', 'center_crop']),
    cam: RectSchema.nullable(),
    game: RectSchema
  })
  .strict()

export const WordSchema = z.object({ t0: seconds, t1: seconds, text: z.string().max(60) }).strict()

/** Fields of a clip the UI may change. Paths are never accepted from the UI. */
export const ClipPatchSchema = z
  .object({
    title: z.string().trim().min(1).max(100),
    start: seconds,
    end: seconds,
    status: z.enum(['pending', 'accepted', 'rejected']),
    words: z.array(WordSchema).max(5000),
    captions: z.object({ enabled: z.boolean(), y: unit, uppercase: z.boolean() }).strict(),
    audio: z.enum(AUDIO_MODES),
    layoutId: id.nullable(),
    formats: z.object({ vertical: z.boolean(), horizontal: z.boolean() }).strict()
  })
  .partial()
  .strict()

export type ClipPatch = z.infer<typeof ClipPatchSchema>

export type CreateJobResult = { ok: true; jobId: string; existing: boolean } | { ok: false; reason: string }

export type SetChannelWatchResult = { ok: true; channel: string } | { ok: false; reason: string }

/** Request channels: name -> [input schema]. */
export const Invoke = {
  'app:info': z.tuple([]),
  'app:openLogFolder': z.tuple([]),
  'app:openOutputFolder': z.tuple([]),
  'app:openLicence': z.tuple([z.string().max(300)]),
  'app:checkUpdates': z.tuple([]),
  'app:installUpdate': z.tuple([]),
  'setup:status': z.tuple([]),
  'setup:start': z.tuple([]),
  'setup:cancel': z.tuple([]),
  'jobs:list': z.tuple([]),
  'jobs:create': z.tuple([z.string().max(300)]),
  'jobs:pause': z.tuple([id]),
  'jobs:resume': z.tuple([id]),
  'jobs:cancel': z.tuple([id]),
  'jobs:delete': z.tuple([id]),
  'clips:list': z.tuple([id]),
  'clips:update': z.tuple([id, ClipPatchSchema]),
  'clips:reset': z.tuple([id]),
  'clips:pickMusic': z.tuple([id]),
  'layouts:list': z.tuple([]),
  'layouts:save': z.tuple([LayoutSchema]),
  'layouts:delete': z.tuple([id]),
  'layouts:setDefault': z.tuple([id.nullable()]),
  'exports:list': z.tuple([id]),
  'exports:start': z.tuple([id, z.array(id).min(1).max(200)]),
  'exports:cancel': z.tuple([id]),
  'exports:show': z.tuple([id]),
  'channelWatch:status': z.tuple([]),
  'channelWatch:set': z.tuple([z.string().max(200)]),
  'channelWatch:clear': z.tuple([])
} as const

export type InvokeChannel = keyof typeof Invoke

// Compile-time check that channels.ts lists exactly the channels above.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never
const _channelsMatch: Same<InvokeChannel, (typeof INVOKE_CHANNELS)[number]> = true
void _channelsMatch

/** What each request returns. */
export interface InvokeResult {
  'app:info': AppInfo
  'app:openLogFolder': void
  'app:openOutputFolder': void
  'app:openLicence': void
  'app:checkUpdates': void
  'app:installUpdate': void
  'setup:status': SetupStatus
  'setup:start': void
  'setup:cancel': void
  'jobs:list': JobSummary[]
  'jobs:create': CreateJobResult
  'jobs:pause': void
  'jobs:resume': void
  'jobs:cancel': void
  'jobs:delete': void
  'clips:list': Clip[]
  'clips:update': Clip
  'clips:reset': Clip
  'clips:pickMusic': Clip | null
  'layouts:list': { layouts: Layout[]; defaultId: string | null }
  'layouts:save': Layout
  'layouts:delete': void
  'layouts:setDefault': void
  'exports:list': ExportItem[]
  'exports:start': string[]
  'exports:cancel': void
  'exports:show': void
  'channelWatch:status': ChannelWatchStatus
  'channelWatch:set': SetChannelWatchResult
  'channelWatch:clear': void
}

/** Events pushed from main to the UI. */
export interface Events {
  'setup:status': SetupStatus
  'jobs:changed': JobSummary
  'exports:changed': ExportItem
  'app:update': UpdateState
  'channelWatch:changed': ChannelWatchStatus
  /** A notification for a ready job was clicked; bring it into view. */
  'jobs:focus': { jobId: string }
}

export type EventChannel = keyof Events

const _eventsMatch: Same<EventChannel, (typeof EVENT_CHANNELS)[number]> = true
void _eventsMatch

/** The API the preload exposes as `window.crapcut`. */
export interface CrapcutApi {
  invoke<C extends InvokeChannel>(channel: C, ...args: z.infer<(typeof Invoke)[C]>): Promise<InvokeResult[C]>
  on<E extends EventChannel>(event: E, listener: (payload: Events[E]) => void): () => void
  /** URL for playing a clip's downloaded video in the review screen. */
  clipUrl(jobId: string, clipId: string): string
}
