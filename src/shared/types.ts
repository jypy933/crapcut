// Types shared by the main process and the renderer. Plain data only.

import type { CaptionStyleId } from './captionStyles'
import type { ClipEditPlan, Platform } from './editPlan'
import type { FormatPositions } from './overlayPosition'
import type { ClipVersion } from './platformExport'
import type { StructureDecision } from './structure'

/** One transcribed word, times in seconds from the start of the VOD. */
export interface Word {
  t0: number
  t1: number
  text: string
  /** Starts a fresh caption group. Only set on the output-timeline words of an edit, at a hard cut back to earlier footage (a cold open's return), never stored. */
  newGroup?: boolean
}

/** One chat message, time in seconds from the start of the VOD. */
export interface ChatMessage {
  t: number
  user: string
  text: string
}

/** A time range in seconds from the start of the VOD. */
export interface Range {
  start: number
  end: number
}

/** Normalised rectangle, 0..1 of the source frame. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

export const STEP_IDS = ['metadata', 'chat', 'audio', 'transcribe', 'moments', 'clipCaptions', 'clips'] as const
export type StepId = (typeof STEP_IDS)[number]

export const STEP_LABELS: Record<StepId, string> = {
  metadata: 'Reading the VOD',
  chat: 'Downloading chat',
  audio: 'Downloading audio',
  transcribe: 'Transcribing',
  moments: 'Finding the best moments',
  clipCaptions: 'Sharpening captions',
  clips: 'Downloading clip video'
}

export type StepStatus = 'pending' | 'running' | 'done' | 'failed' | 'skipped'

export interface StepState {
  status: StepStatus
  /** 0..1 */
  progress: number
  /** Seconds left, when known. */
  etaSec: number | null
  detail: string | null
}

export type JobStatus =
  | 'queued'
  | 'running'
  | 'paused'
  | 'review'
  | 'failed'
  | 'cancelled'

export interface VodInfo {
  id: string
  title: string
  channel: string
  durationSec: number
  createdAt: string | null
  thumbnailUrl: string | null
}

export interface JobSummary {
  id: string
  url: string
  vodId: string
  vod: VodInfo | null
  status: JobStatus
  /** The step currently running or next to run. */
  currentStep: StepId | null
  steps: Record<StepId, StepState>
  /** One plain sentence, only when status is 'failed'. */
  error: string | null
  createdAt: number
  updatedAt: number
  clipCount: number
}

export type ClipStatus = 'pending' | 'accepted' | 'rejected'

/** Which signal a moment came from, for taste learning. */
export type MomentSource = 'chat' | 'audio' | 'transcript'

/** The signal features behind a proposed moment, kept so later decisions can be learned from. */
export interface MomentSignals {
  chatZ: number
  audioZ: number
  /** 0..1 combined signal strength, before any LLM rating. */
  score: number
  /** LLM rating 1..10, or null when the LLM did not see this candidate. */
  rating: number | null
  source: MomentSource
}

/** How the virality score ranked a clip within its job; see `main/core/virality.ts`. */
export interface ClipVirality {
  /** 0..1, best moments first. Only ever used to order clips and pre-select, never shown as a number. */
  score: number
  /** Clearly strong for this job, so it started out accepted. */
  topPick: boolean
}

export const AUDIO_MODES = ['original', 'voice', 'voice_game', 'voice_music'] as const
export type AudioMode = (typeof AUDIO_MODES)[number]

export const AUDIO_MODE_LABELS: Record<AudioMode, string> = {
  original: 'Original',
  voice: 'Voice only',
  voice_game: 'Voice + quieter game',
  voice_music: 'Voice + my music'
}

export interface CaptionSettings {
  enabled: boolean
  /** Vertical centre of the caption block in 9:16, 0 (top) .. 1 (bottom). */
  y: number
  /** The same for 16:9 when he moved it there; missing means the default (see shared/captionPlacement.ts). */
  yHorizontal?: number
  uppercase: boolean
  styleId: CaptionStyleId
}

export interface ClipFormats {
  vertical: boolean
  horizontal: boolean
}

export interface Clip {
  id: string
  jobId: string
  rank: number
  /** 0..1, how strong the moment looked. */
  score: number
  title: string
  /** The cut, in VOD seconds. */
  start: number
  end: number
  /** What the finder originally chose, for "reset". */
  suggested: Range
  /** The downloaded video range (padded), in VOD seconds; null until downloaded. */
  source: Range | null
  status: ClipStatus
  /** Caption words for this clip (VOD seconds), editable. */
  words: Word[]
  /**
   * Set once he edits this clip's caption text in Review. Missing (old rows)
   * or false means the words are still whatever the pipeline last produced,
   * so the CPU-only clip-captions step is free to replace them with a
   * cleaner re-transcription.
   */
  wordsEdited?: boolean
  captions: CaptionSettings
  /** Chat messages in this clip's time range (VOD seconds), padded like `words`. */
  chatMessages: ChatMessage[]
  /** Shows the chat overlay for this clip. Off by default. */
  chatOverlay: boolean
  /** Where he dragged the chat box (its top-left corner in the output frame), per format; missing means the default. */
  chatPos?: FormatPositions
  audio: AudioMode
  /** Absolute path of the music file for 'voice_music'. */
  musicPath: string | null
  layoutId: string | null
  formats: ClipFormats
  /** Why it was picked, short, e.g. "Chat spike · laughter". */
  reason: string
  /** The signal features behind this moment; null for clips saved before this existed. */
  signals: MomentSignals | null
  /**
   * The automatic re-edit's chosen structure and its picks (quote span,
   * emphasis words, cold open...). Computed once moments are found (with the
   * language model when it is available); null only until that first compute
   * has happened, and for a clip saved before this existed (filled in lazily
   * on next read -- see `pipeline/clipNormalize.ts`).
   */
  structureDecision: StructureDecision | null
  /** Applies the automatic viral edit at export; on by default, off per clip. */
  autoEdit: boolean
  /**
   * What the auto edit's rule engine decided (final length, per-platform cap
   * fit, cold-open plan and confidence, loop eligibility and seam score);
   * see `main/core/editPlan.ts`. Set when moments are found and refreshed
   * whenever the edit is built for a preview or an export; missing on a clip
   * saved before it existed.
   */
  editPlan?: ClipEditPlan
  /**
   * Which version is previewed and exported: the straight edit (also when
   * missing) or the cold open, which only exists when `editPlan.coldOpen`
   * qualifies. See `shared/platformExport.ts`.
   */
  version?: ClipVersion
  /** Set when moments are found (and filled in on load for a clip saved before it existed). */
  virality?: ClipVirality
}

export type LayoutKind = 'cam_game' | 'blur_fill' | 'center_crop'

export interface Layout {
  id: string
  name: string
  kind: LayoutKind
  /** Facecam area in the source frame (cam_game only). */
  cam: Rect | null
  /** Game area in the source frame; the full frame by default. */
  game: Rect
}

export type ExportStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'
export type ExportFormat = 'vertical' | 'horizontal'

export interface ExportItem {
  id: string
  jobId: string
  clipId: string
  format: ExportFormat
  /** The platform a vertical export is made for; null for 16:9 and for exports made before platforms existed. */
  platform: Platform | null
  status: ExportStatus
  progress: number
  etaSec: number | null
  file: string | null
  error: string | null
  /** One plain sentence when this export was left out or shortened (a platform's length cap), else null. */
  note: string | null
  createdAt: number
}

export type BestOfStatus = 'queued' | 'running' | 'done' | 'failed' | 'cancelled'

/** One "best of the stream" 16:9 build: the job's kept clips joined with crossfades. */
export interface BestOfItem {
  id: string
  jobId: string
  status: BestOfStatus
  progress: number
  etaSec: number | null
  file: string | null
  error: string | null
  createdAt: number
}

export type AutoEditPreviewStatus = 'building' | 'ready' | 'error' | 'off'

/** Where a clip's automatic-edit preview render stands; pushed as `autoEditPreview:changed`. */
export interface AutoEditPreviewState {
  clipId: string
  status: AutoEditPreviewStatus
  /** A cache-busting stamp for the current cached preview file, or null with none ready yet. */
  version: string | null
}

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'other'

export interface GpuInfo {
  vendor: GpuVendor
  name: string
  vramMb: number | null
}

export interface HardwareProfile {
  gpus: GpuInfo[]
  /** The GPU used for AI work, if any. */
  primary: GpuInfo | null
  /** What whisper.cpp will run on. */
  whisper: 'cuda' | 'vulkan' | 'cpu'
  /** What llama.cpp will run on. */
  llm: 'vulkan' | 'cpu'
  /** The CUDA build of llama.cpp is worth fetching and trying first (NVIDIA, new enough driver). Vulkan stays as the fallback. */
  llmCuda?: boolean
  totalRamMb: number
  cpuThreads: number
}

export type ComponentState = 'missing' | 'downloading' | 'verifying' | 'installing' | 'ready' | 'failed'

export interface SetupComponent {
  id: string
  label: string
  sizeBytes: number
  state: ComponentState
  progress: number
  optional: boolean
}

export interface SetupStatus {
  ready: boolean
  running: boolean
  components: SetupComponent[]
  /** Bytes still to download. */
  remainingBytes: number
  freeBytes: number | null
  etaSec: number | null
  error: string | null
  hardware: HardwareProfile | null
}

export interface LicenceNotice {
  name: string
  version: string
  licence: string
  url: string
  note: string | null
}

export interface AppInfo {
  version: string
  outputDir: string
  features: { voiceSeparation: boolean }
  licences: LicenceNotice[]
  update: UpdateState
}

/** The one channel CrapCut watches for new VODs. */
export interface ChannelWatch {
  channel: string
  /** Epoch ms the watch was turned on, for display only. */
  enabledAt: number
  /**
   * The newest VOD id seen the first time a check succeeded after the watch
   * was turned on. Twitch VOD ids only ever increase, so anything with a
   * greater id is new. Null until that first check has run.
   */
  baselineId: string | null
}

export interface ChannelWatchStatus {
  channel: string | null
  enabledAt: number | null
  checking: boolean
  lastCheckedAt: number | null
  /** One plain sentence, from the most recent check. */
  lastError: string | null
}

/** "Start CrapCut with Windows". Off by default, on by default while a channel is watched, unless the user has said otherwise. */
export interface AutostartStatus {
  enabled: boolean
  /** True once the user has explicitly turned the toggle on or off; from then on their choice sticks. */
  userSet: boolean
}

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; progress: number }
  | { kind: 'ready'; version: string }
  | { kind: 'none' }
  | { kind: 'error' }
