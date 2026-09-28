// Types shared by the main process and the renderer. Plain data only.

import type { CaptionStyleId } from './captionStyles'

/** One transcribed word, times in seconds from the start of the VOD. */
export interface Word {
  t0: number
  t1: number
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

export const STEP_IDS = ['metadata', 'chat', 'audio', 'transcribe', 'moments', 'clips'] as const
export type StepId = (typeof STEP_IDS)[number]

export const STEP_LABELS: Record<StepId, string> = {
  metadata: 'Reading the VOD',
  chat: 'Downloading chat',
  audio: 'Downloading audio',
  transcribe: 'Transcribing',
  moments: 'Finding the best moments',
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
  /** Vertical centre of the caption block, 0 (top) .. 1 (bottom). */
  y: number
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
  captions: CaptionSettings
  audio: AudioMode
  /** Absolute path of the music file for 'voice_music'. */
  musicPath: string | null
  layoutId: string | null
  formats: ClipFormats
  /** Why it was picked, short, e.g. "Chat spike · laughter". */
  reason: string
  /** The signal features behind this moment; null for clips saved before this existed. */
  signals: MomentSignals | null
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
  status: ExportStatus
  progress: number
  etaSec: number | null
  file: string | null
  error: string | null
  createdAt: number
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
  whisper: 'cuda' | 'cpu'
  /** What llama.cpp will run on. */
  llm: 'vulkan' | 'cpu'
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

export type UpdateState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'available'; version: string }
  | { kind: 'downloading'; progress: number }
  | { kind: 'ready'; version: string }
  | { kind: 'none' }
  | { kind: 'error' }
