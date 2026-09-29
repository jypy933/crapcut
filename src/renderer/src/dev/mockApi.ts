// Development only: a fake backend so the UI can be viewed in a plain browser
// (npm run dev:ui). Never included in the packaged app.

import { parseChannelName } from '@shared/channelName'
import type { CrapcutApi, EventChannel, Events, InvokeChannel } from '@shared/ipc'
import { optionalModelArtifactIds, type OptionalModelId } from '@shared/optionalModels'
import type { AppInfo, AutostartStatus, BestOfItem, ChannelWatchStatus, Clip, ExportItem, HardwareProfile, JobSummary, Layout, SetupComponent, SetupStatus, StepId, StepState, Word } from '@shared/types'

const listeners = new Map<string, Set<(p: unknown) => void>>()
function emit<E extends EventChannel>(e: E, p: Events[E]): void {
  for (const l of listeners.get(e) ?? []) l(p)
}

const step = (status: StepState['status'], progress = status === 'done' ? 1 : 0, etaSec: number | null = null, detail: string | null = null): StepState => ({
  status,
  progress,
  etaSec,
  detail
})
const allDone = (): Record<StepId, StepState> => ({ metadata: step('done'), chat: step('done'), audio: step('done'), transcribe: step('done'), moments: step('done'), clips: step('done') })

const params = new URLSearchParams(location.search)
let setupReady = params.get('setup') !== '1'

// Mutable so the optional-AI-parts simulation below can move a component
// through downloading -> verifying -> ready over time.
const modelComponents: SetupComponent[] = [
  { id: 'ffmpeg', label: 'FFmpeg', sizeBytes: 109282242, state: 'ready', progress: 1, optional: false },
  { id: 'yt-dlp', label: 'yt-dlp', sizeBytes: 17840399, state: 'ready', progress: 1, optional: false },
  { id: 'chat-downloader', label: 'TwitchDownloaderCLI', sizeBytes: 52226305, state: 'downloading', progress: 0.42, optional: false },
  { id: 'whisper-cuda', label: 'whisper.cpp (NVIDIA)', sizeBytes: 272982859, state: 'missing', progress: 0, optional: false },
  { id: 'model-whisper-large', label: 'Speech model (Whisper large-v3-turbo)', sizeBytes: 874188075, state: 'missing', progress: 0, optional: false },
  // Optional AI parts, offered again later from the About screen.
  { id: 'llama', label: 'llama.cpp', sizeBytes: 33064176, state: 'ready', progress: 1, optional: true },
  { id: 'model-llm-8b', label: 'Language model (Ministral 3 8B)', sizeBytes: 5198911904, state: 'missing', progress: 0, optional: true },
  { id: 'separator', label: 'Voice separator (demucs.cpp)', sizeBytes: 2102181, state: 'missing', progress: 0, optional: true },
  { id: 'model-demucs', label: 'Voice separation model (Demucs htdemucs)', sizeBytes: 83994361, state: 'missing', progress: 0, optional: true }
]

const hardware: HardwareProfile = { gpus: [], primary: { vendor: 'nvidia', name: 'NVIDIA GeForce RTX 3080', vramMb: 10240 }, whisper: 'cuda', llm: 'vulkan', totalRamMb: 16384, cpuThreads: 16 }

let modelsRunning = false

const setup = (): SetupStatus => ({
  ready: setupReady,
  running: modelsRunning,
  components: modelComponents,
  remainingBytes: 6_300_000_000,
  freeBytes: 412_000_000_000,
  etaSec: null,
  error: null,
  hardware
})

// Simulates the settings screen's Download/Cancel flow: one artifact at a
// time moves through downloading -> verifying -> ready, pushed as
// 'setup:status' events just like the real setup manager.
let modelTimer: ReturnType<typeof setInterval> | null = null

function stopModelDownload(cancelled: boolean): void {
  if (modelTimer) clearInterval(modelTimer)
  modelTimer = null
  modelsRunning = false
  if (cancelled) {
    for (const c of modelComponents) {
      if (c.state === 'downloading' || c.state === 'verifying' || c.state === 'installing') {
        c.state = 'missing'
        c.progress = 0
      }
    }
  }
  emit('setup:status', setup())
}

function simulateModelDownload(ids: readonly string[]): void {
  if (modelsRunning) return
  const todo = modelComponents.filter((c) => ids.includes(c.id) && c.state !== 'ready')
  if (!todo.length) return
  modelsRunning = true
  let i = 0
  modelTimer = setInterval(() => {
    const c = todo[i]
    if (!c) {
      stopModelDownload(false)
      return
    }
    c.state = c.progress < 0.8 ? 'downloading' : 'verifying'
    c.progress = Math.min(1, c.progress + 0.25)
    if (c.progress >= 1) {
      c.state = 'ready'
      i += 1
    }
    emit('setup:status', setup())
  }, 350)
}

const vod = { id: '2883949120', title: 'Late night ranked grind, road to top 500', channel: 'streamer', durationSec: 5 * 3600 + 1234, createdAt: null, thumbnailUrl: null }

const jobs: JobSummary[] = [
  {
    id: 'job-aaaaaa01',
    url: 'https://www.twitch.tv/videos/2883949120',
    vodId: '2883949120',
    vod,
    status: 'review',
    currentStep: null,
    steps: allDone(),
    error: null,
    createdAt: Date.now() - 3600_000,
    updatedAt: Date.now(),
    clipCount: 6
  },
  {
    id: 'job-aaaaaa02',
    url: 'https://www.twitch.tv/videos/2883000001',
    vodId: '2883000001',
    vod: { ...vod, id: '2883000001', title: 'Just chatting + new game day', durationSec: 3 * 3600 + 400 },
    status: 'running',
    currentStep: 'transcribe',
    steps: { ...allDone(), transcribe: step('running', 0.37, 780), moments: step('pending'), clips: step('pending') },
    error: null,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    clipCount: 0
  },
  {
    id: 'job-aaaaaa03',
    url: 'https://www.twitch.tv/videos/2881000002',
    vodId: '2881000002',
    vod: { ...vod, id: '2881000002', title: 'Speedrun attempts', durationSec: 2 * 3600 },
    status: 'failed',
    currentStep: 'audio',
    steps: { ...allDone(), audio: step('failed', 0.2), transcribe: step('pending'), moments: step('pending'), clips: step('pending') },
    error: 'Could not reach Twitch. Check your internet connection.',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    clipCount: 0
  }
]

function words(start: number, text: string): Word[] {
  return text.split(' ').map((t, i) => ({ t0: start + i * 0.38, t1: start + i * 0.38 + 0.32, text: t }))
}

const titles = ['He did NOT see that coming', 'Chat lost it at this', 'The cleanest clutch ever', 'Wait for the ending...', 'Worst luck of the stream', "This is why we don't trust him"]
let clips: Clip[] = titles.map((title, i) => {
  const start = 1000 + i * 1500
  return {
    id: `clip-bbbbbb0${i}`,
    jobId: 'job-aaaaaa01',
    rank: i + 1,
    score: Math.round((0.92 - i * 0.08) * 100) / 100,
    title,
    start,
    end: start + 28 + i * 3,
    suggested: { start, end: start + 28 + i * 3 },
    source: { start: start - 20, end: start + 48 + i * 3 },
    status: i === 0 ? 'accepted' : i === 3 ? 'rejected' : 'pending',
    words: words(start + 1, 'okay okay watch this one guys no way he actually did that I cannot believe what just happened chat is going crazy right now this is insane'),
    captions: { enabled: true, y: 0.72, uppercase: true, styleId: 'clean' },
    audio: 'original',
    musicPath: null,
    layoutId: null,
    formats: { vertical: true, horizontal: false },
    reason: i % 2 ? 'Chat spike · laughter' : 'Chat spike · hype · loud',
    signals: { chatZ: 3.2, audioZ: 1.1, score: 0.7, rating: 7, source: i % 2 ? 'chat' : 'audio' }
  }
})
let layouts: Layout[] = []
let exports: ExportItem[] = []
let bestOf: BestOfItem[] = []
let channelWatch: ChannelWatchStatus = { channel: null, enabledAt: null, checking: false, lastCheckedAt: null, lastError: null }
let autostart: AutostartStatus = { enabled: false, userSet: false }

const info: AppInfo = {
  version: '0.1.0',
  outputDir: 'C:\\Users\\you\\Videos\\CrapCut',
  features: { voiceSeparation: false },
  licences: [
    { name: 'FFmpeg', version: '8.1.1', licence: 'GPL-3.0', url: 'https://ffmpeg.org/legal.html', note: 'Windows build by gyan.dev' },
    { name: 'yt-dlp', version: '2026.08.19', licence: 'Unlicense', url: 'https://github.com/yt-dlp/yt-dlp', note: null },
    { name: 'whisper.cpp', version: '1.9.4', licence: 'MIT', url: 'https://github.com/ggml-org/whisper.cpp', note: null }
  ],
  update: { kind: 'none' }
}

const handlers: Partial<Record<InvokeChannel, (...a: never[]) => unknown>> = {
  'app:info': () => info,
  'setup:status': () => setup(),
  'setup:start': () => {
    setupReady = true
    emit('setup:status', setup())
  },
  'setup:cancel': () => stopModelDownload(true),
  'jobs:list': () => jobs,
  'jobs:create': () => ({ ok: false, reason: 'This is the UI preview; no real jobs run here.' }),
  'clips:list': (jobId: string) => clips.filter((c) => c.jobId === jobId),
  'clips:update': (id: string, patch: Partial<Clip>) => {
    clips = clips.map((c) => (c.id === id ? { ...c, ...patch } : c))
    return clips.find((c) => c.id === id)
  },
  'clips:reset': (id: string) => clips.find((c) => c.id === id),
  'clips:pickMusic': () => null,
  'layouts:list': () => ({ layouts, defaultId: layouts[0]?.id ?? null }),
  'layouts:save': (l: Layout) => {
    layouts = [l, ...layouts.filter((x) => x.id !== l.id)]
    return l
  },
  'exports:list': () => exports,
  'exports:start': (jobId: string, ids: string[]) => {
    exports = ids.map((clipId, i) => ({ id: `exp-cccccc0${i}`, jobId, clipId, format: 'vertical', status: i ? 'queued' : 'running', progress: 0.35, etaSec: 40, file: null, error: null, createdAt: Date.now() }))
    for (const e of exports) emit('exports:changed', e)
    return exports.map((e) => e.id)
  },
  'bestOf:list': (jobId: string) => bestOf.filter((b) => b.jobId === jobId),
  'bestOf:start': (jobId: string) => {
    const id = `bestof-${Date.now()}`
    const item: BestOfItem = { id, jobId, status: 'running', progress: 0.15, etaSec: 18, file: null, error: null, createdAt: Date.now() }
    bestOf = [...bestOf.filter((b) => b.jobId !== jobId), item]
    emit('bestOf:changed', item)
    setTimeout(() => {
      const done: BestOfItem = { ...item, status: 'done', progress: 1, etaSec: null, file: 'C:\\Users\\you\\Videos\\CrapCut\\Best of - preview (16x9).mp4' }
      bestOf = bestOf.map((b) => (b.id === id ? done : b))
      emit('bestOf:changed', done)
    }, 2500)
    return id
  },
  'bestOf:cancel': (id: string) => {
    bestOf = bestOf.map((b) => (b.id === id ? { ...b, status: 'cancelled' as const } : b))
    const item = bestOf.find((b) => b.id === id)
    if (item) emit('bestOf:changed', item)
  },
  'bestOf:show': () => undefined,
  'taste:status': () => ({ tuned: true }),
  'taste:reset': () => undefined,
  'channelWatch:status': () => channelWatch,
  'channelWatch:set': (text: string) => {
    const parsed = parseChannelName(text)
    if (!parsed.ok) return { ok: false, reason: parsed.reason }
    channelWatch = { channel: parsed.channel, enabledAt: Date.now(), checking: false, lastCheckedAt: null, lastError: null }
    emit('channelWatch:changed', channelWatch)
    return { ok: true, channel: parsed.channel }
  },
  'channelWatch:clear': () => {
    channelWatch = { channel: null, enabledAt: null, checking: false, lastCheckedAt: null, lastError: null }
    emit('channelWatch:changed', channelWatch)
  },
  'settings:getAutostart': () => autostart,
  'settings:setAutostart': (enabled: boolean) => {
    autostart = { enabled, userSet: true }
    return autostart
  },
  'models:download': (id: OptionalModelId) => simulateModelDownload(optionalModelArtifactIds(id, hardware)),
  'models:remove': (id: OptionalModelId) => {
    const ids: string[] = optionalModelArtifactIds(id, hardware)
    for (const c of modelComponents) if (ids.includes(c.id)) { c.state = 'missing'; c.progress = 0 }
    emit('setup:status', setup())
  }
}

export function installMockApi(sampleVideo: string): void {
  const api: CrapcutApi = {
    invoke: (async (channel: InvokeChannel, ...args: unknown[]) => {
      const h = handlers[channel] as ((...a: unknown[]) => unknown) | undefined
      return h ? h(...args) : undefined
    }) as CrapcutApi['invoke'],
    on: ((event: string, l: (p: unknown) => void) => {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event)!.add(l)
      return () => listeners.get(event)!.delete(l)
    }) as CrapcutApi['on'],
    clipUrl: () => sampleVideo
  }
  ;(window as { crapcut?: CrapcutApi }).crapcut = api
}
