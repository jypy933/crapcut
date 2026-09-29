// Development only: a fake backend so the UI can be viewed in a plain browser
// (npm run dev:ui). Never included in the packaged app.

import { parseChannelName } from '@shared/channelName'
import type { CrapcutApi, EventChannel, Events, InvokeChannel } from '@shared/ipc'
import { optionalModelArtifactIds, type OptionalModelId } from '@shared/optionalModels'
import type { AppInfo, AutostartStatus, BestOfItem, ChannelWatchStatus, ChatMessage, Clip, ExportItem, HardwareProfile, JobSummary, Layout, SetupComponent, SetupStatus, StepId, StepState, Word } from '@shared/types'

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
const allDone = (): Record<StepId, StepState> => ({
  metadata: step('done'),
  chat: step('done'),
  audio: step('done'),
  transcribe: step('done'),
  moments: step('done'),
  clipCaptions: step('done'),
  clips: step('done')
})

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
  { id: 'model-llm-9b', label: 'Language model (Qwen3.5 9B)', sizeBytes: 5680522464, state: 'missing', progress: 0, optional: true },
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
    clipCount: 7
  },
  {
    id: 'job-aaaaaa02',
    url: 'https://www.twitch.tv/videos/2883000001',
    vodId: '2883000001',
    vod: { ...vod, id: '2883000001', title: 'Just chatting + new game day', durationSec: 3 * 3600 + 400 },
    status: 'running',
    currentStep: 'transcribe',
    steps: { ...allDone(), transcribe: step('running', 0.37, 780, 'Part 5 of 12'), moments: step('pending'), clips: step('pending') },
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
  },
  {
    id: 'job-aaaaaa04',
    url: 'https://www.twitch.tv/videos/2880000003',
    vodId: '2880000003',
    vod: { ...vod, id: '2880000003', title: 'Community game night', durationSec: 4 * 3600 + 900 },
    status: 'running',
    currentStep: 'clipCaptions',
    steps: { ...allDone(), clipCaptions: step('running', 0.25, 95, 'Clip 3 of 12'), clips: step('pending') },
    error: null,
    createdAt: Date.now() - 1000,
    updatedAt: Date.now(),
    clipCount: 12
  },
  {
    id: 'job-aaaaaa05',
    url: 'https://www.twitch.tv/videos/2879000004',
    vodId: '2879000004',
    vod: { ...vod, id: '2879000004', title: 'Waiting in line', durationSec: 2 * 3600 + 60 },
    status: 'queued',
    currentStep: 'metadata',
    steps: { ...allDone(), metadata: step('pending'), chat: step('pending'), audio: step('pending'), transcribe: step('pending'), moments: step('pending'), clipCaptions: step('pending'), clips: step('pending') },
    error: null,
    createdAt: Date.now() - 2000,
    updatedAt: Date.now(),
    clipCount: 0
  }
]

function words(start: number, text: string): Word[] {
  return text.split(' ').map((t, i) => ({ t0: start + i * 0.38, t1: start + i * 0.38 + 0.32, text: t }))
}

const CHAT_USERS = ['zap', 'kayleigh_', 'PixelPunk', 'streamfan99', 'glorbo', '해달서준', 'xX_Wolf_Xx', 'noodle_soup']
const CHAT_LINES = ['KEKW', 'no way', 'LOL', 'lets goooooo', 'clip it', 'that is insane', 'bro what', 'PogChamp', 'hahahaha', 'W clip', 'chat is this real']

/** A believable burst of reactions across a clip's time range, for the dev UI only. */
function fakeChat(start: number, end: number): ChatMessage[] {
  const out: ChatMessage[] = []
  let t = start
  let i = 0
  while (t < end) {
    out.push({ t: Math.floor(t), user: CHAT_USERS[i % CHAT_USERS.length]!, text: CHAT_LINES[(i * 3) % CHAT_LINES.length]! })
    t += 0.5 + (i % 3) * 0.35
    i++
  }
  return out
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
    chatMessages: fakeChat(start - 20, start + 48 + i * 3),
    chatOverlay: i === 0,
    audio: 'original',
    musicPath: null,
    layoutId: null,
    formats: { vertical: true, horizontal: false },
    reason: i % 2 ? 'Chat spike · laughter' : 'Chat spike · hype · loud',
    signals: { chatZ: 3.2, audioZ: 1.1, score: 0.7, rating: 7, source: i % 2 ? 'chat' : 'audio' },
    structureDecision: null,
    autoEdit: true
  }
})
// Dev-only regression fixture for the Timeline trim bar: word marks whose
// range runs wider than the clip's downloaded source on both sides, plus one
// stretched (whisper-style) word, so an unclamped bar would draw past its
// edges. See src/renderer/src/components/Timeline.tsx.
clips.push({
  id: 'clip-timelinetest',
  jobId: 'job-aaaaaa01',
  rank: clips.length + 1,
  score: 0.5,
  title: 'Timeline overflow fixture',
  start: 5006,
  end: 5024,
  suggested: { start: 5006, end: 5024 },
  source: { start: 5005, end: 5025 },
  status: 'pending',
  words: [
    { t0: 4996, t1: 5008, text: 'before' }, // crosses the left edge of source
    { t0: 5008, t1: 5010, text: 'okay' },
    { t0: 5010, t1: 5021, text: 'stretchedword' }, // an 11 s "word": the whisper stretch bug
    { t0: 5021, t1: 5023, text: 'right' },
    { t0: 5023, t1: 5040, text: 'after' } // crosses the right edge of source
  ],
  captions: { enabled: true, y: 0.72, uppercase: true, styleId: 'clean' },
  chatMessages: [],
  chatOverlay: false,
  audio: 'original',
  musicPath: null,
  layoutId: null,
  formats: { vertical: true, horizontal: false },
  reason: 'Dev fixture',
  signals: { chatZ: 0, audioZ: 0, score: 0.5, rating: null, source: 'audio' },
  structureDecision: null,
  autoEdit: true
})
let layouts: Layout[] = []
let defaultLayoutId: string | null = null
let exports: ExportItem[] = []
let bestOf: BestOfItem[] = []

// `?work=1` seeds a batch of exports and a best-of build on the first job (the
// one in review) and lets every running thing creep forward, so the progress
// lines, the title-bar pill and the "time left" hiding can be seen moving.
if (params.get('work') === '1') {
  const now = Date.now()
  const item = (n: number, status: ExportItem['status'], progress: number, etaSec: number | null): ExportItem => ({ id: `exp-seed000${n}`, jobId: 'job-aaaaaa01', clipId: `clip-bbbbbb0${n}`, format: 'vertical', status, progress, etaSec, file: null, error: null, createdAt: now })
  exports = [item(0, 'done', 1, null), item(1, 'running', 0.45, 75), item(2, 'queued', 0, null), item(3, 'queued', 0, null)]
  bestOf = [{ id: 'bestof-seed0001', jobId: 'job-aaaaaa01', status: 'running', progress: 0.3, etaSec: 40, file: null, error: null, createdAt: now }]
}

// Jobs always creep forward a little so their status line stays fresh.
setInterval(() => {
  const now = Date.now()
  for (const j of jobs) {
    if (j.status !== 'running' || !j.currentStep) continue
    const st = j.steps[j.currentStep]
    st.progress = Math.min(0.99, st.progress + 0.004)
    j.updatedAt = now
    emit('jobs:changed', { ...j })
  }
  if (params.get('work') !== '1') return
  for (const e of exports) {
    if (e.status !== 'running') continue
    e.progress = Math.min(1, e.progress + 0.03)
    e.etaSec = Math.max(0, Math.round((1 - e.progress) * 40))
    if (e.progress >= 1) {
      e.status = 'done'
      e.etaSec = null
      const next = exports.find((x) => x.status === 'queued')
      if (next) next.status = 'running'
      if (next) emit('exports:changed', { ...next })
    }
    emit('exports:changed', { ...e })
  }
  for (const b of bestOf) {
    if (b.status !== 'running') continue
    b.progress = Math.min(1, b.progress + 0.02)
    b.etaSec = Math.max(0, Math.round((1 - b.progress) * 50))
    if (b.progress >= 1) (b.status = 'done', (b.etaSec = null))
    emit('bestOf:changed', { ...b })
  }
}, 1000)
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
  'clips:previewAutoEdit': (clipId: string) => {
    const state = { clipId, status: 'building' as const, version: null }
    setTimeout(() => emit('autoEditPreview:changed', { clipId, status: 'ready', version: 'preview' }), 900)
    return state
  },
  'layouts:list': () => ({ layouts, defaultId: defaultLayoutId }),
  'layouts:save': (l: Layout) => {
    // Like the real store: newest first, replaced in place by id.
    layouts = [l, ...layouts.filter((x) => x.id !== l.id)]
    return l
  },
  'layouts:delete': (id: string) => {
    layouts = layouts.filter((x) => x.id !== id)
    if (defaultLayoutId === id) defaultLayoutId = null
  },
  'layouts:setDefault': (id: string | null) => {
    defaultLayoutId = id && layouts.some((x) => x.id === id) ? id : null
  },
  'exports:list': (jobId: string) => exports.filter((e) => e.jobId === jobId),
  'work:list': () => ({ exports, bestOf }),
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
    clipUrl: () => sampleVideo,
    previewUrl: () => sampleVideo
  }
  ;(window as { crapcut?: CrapcutApi }).crapcut = api
}
