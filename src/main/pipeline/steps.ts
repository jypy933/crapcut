// The six pipeline steps. Each one is idempotent: it checks what is already on
// disk and continues from there, so a crash or reboot loses at most a little
// work (one transcription chunk, one clip download).

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Clip, HardwareProfile, JobSummary, Range, StepId, VodInfo, Word } from '@shared/types'
import { bestLag, envelope, pcm16ToFloat } from '../core/align'
import { parseChatLog } from '../core/chat'
import {
  ANSWER_SCHEMA,
  buildPrompt,
  buildScanPrompt,
  combinedScore,
  excerptLines,
  excerptRange,
  parseAnswer,
  scanWindows,
  SYSTEM_PROMPT,
  topChat,
  type Refined
} from '../core/llmPrompt'
import { mergeRanges, parseLoudnessLog } from '../core/media'
import { fallbackTitle, findCandidates, selectNonOverlapping, targetClipCount, type Candidate } from '../core/moments'
import { CHUNK_FORMAT, mergeChunks, packWords, parseWhisperJson, placeChunkWords, planChunks, unpackWords, wordsIn, type PackedWord } from '../core/transcript'
import type { AppPaths } from '../paths'
import type { Store } from '../store'
import { nvidiaFreeVramMb } from '../tools/gpu'
import type { ToolRegistry } from '../tools/registry'
import { CancelledError, UserError, isCancelled, throwIfAborted } from '../util/errors'
import type { Logger } from '../util/log'
import { downloadChat, LlamaServer, whisperChunk } from './ai'
import type { GpuLock } from './gpuLock'
import { cutWav, extractPcm, fetchMutedRanges, prepareAudio, probeMedia, silentRanges } from './media'
import { downloadAudio, downloadSection, fetchVodMeta } from './ytdlp'

export interface StepContext {
  job: JobSummary
  dir: string
  paths: AppPaths
  store: Store
  tools: ToolRegistry
  hw: HardwareProfile
  gpu: GpuLock
  signal: AbortSignal
  log: Logger
  /** Tests only: use this GGUF instead of the installed language model. */
  llmModelOverride?: string
  /** Reports 0..1 progress for the current step, with an optional detail line. */
  progress: (fraction: number, detail?: string | null) => void
}

export interface JobMeta {
  vod: VodInfo
  chapters: { start: number; end: number; title: string }[]
  mutedFromPlaylist: Range[]
}

/** Seconds of extra video kept on each side of a clip for trimming in review. */
export const CLIP_PAD_SEC = 20

async function readJson<T>(file: string): Promise<T> {
  return JSON.parse(await readFile(file, 'utf8')) as T
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
  const tmp = `${file}.tmp`
  await writeFile(tmp, JSON.stringify(data))
  renameSync(tmp, file)
}

export async function loadMeta(dir: string): Promise<JobMeta> {
  return readJson<JobMeta>(join(dir, 'meta.json'))
}

// ---------------------------------------------------------------- metadata

async function metadata(ctx: StepContext): Promise<void> {
  const file = join(ctx.dir, 'meta.json')
  if (existsSync(file)) return
  ctx.progress(0.1)
  const meta = await fetchVodMeta(ctx.tools.require('yt-dlp'), ctx.job.url, ctx.job.vodId, ctx.signal)
  if (meta.isLive) throw new UserError('This stream is still live. Try again when it has ended.', { retryable: false })
  let muted: Range[] = []
  if (meta.audioPlaylistUrl) {
    try {
      muted = await fetchMutedRanges(meta.audioPlaylistUrl, ctx.signal)
    } catch (err) {
      if (isCancelled(err)) throw err
      ctx.log.warn('could not read muted segments; will detect silence instead', err)
    }
  }
  const data: JobMeta = { vod: meta.info, chapters: meta.chapters, mutedFromPlaylist: muted }
  await writeJsonAtomic(file, data)
  ctx.store.setVod(ctx.job.id, meta.info)
  ctx.log.info(`vod ${meta.info.id}: ${Math.round(meta.info.durationSec)} s, ${muted.length} muted ranges`)
}

// ---------------------------------------------------------------- chat

async function chat(ctx: StepContext): Promise<void> {
  const file = join(ctx.dir, 'chat.txt')
  if (existsSync(file)) return
  const partial = join(ctx.dir, 'chat.partial.txt')
  const tmp = join(ctx.dir, 'tmp')
  mkdirSync(tmp, { recursive: true })
  await downloadChat(ctx.tools.require('chat-downloader'), ctx.job.vodId, partial, tmp, ctx.signal, (f) => ctx.progress(f))
  if (!existsSync(partial)) writeFileSync(partial, '')
  renameSync(partial, file)
}

// ---------------------------------------------------------------- audio

function findAudioFile(dir: string): string | null {
  for (const f of readdirSync(dir)) if (/^audio\.(mp4|m4a|aac|ts|webm|mkv|mp3|opus)$/i.test(f)) return join(dir, f)
  return null
}

async function audio(ctx: StepContext): Promise<void> {
  const wav = join(ctx.dir, 'audio16k.wav')
  const loud = join(ctx.dir, 'loudness.txt')
  const meta = await loadMeta(ctx.dir)
  const ffmpeg = ctx.tools.require('ffmpeg')

  let src = findAudioFile(ctx.dir)
  if (!src) {
    await downloadAudio(ctx.tools.require('yt-dlp'), ffmpeg, ctx.job.url, join(ctx.dir, 'audio.%(ext)s'), ctx.signal, (f) => ctx.progress(f * 0.8, 'Downloading'))
    src = findAudioFile(ctx.dir)
    if (!src) throw new UserError('The audio download did not produce a file. Try again.')
  }

  if (!existsSync(loud) || !existsSync(join(ctx.dir, 'muted.json')) || (!existsSync(wav) && !transcriptDone(ctx.dir))) {
    await prepareAudio(ffmpeg, ctx.dir, relative(ctx.dir, src), 'audio16k.tmp.wav', 'loudness.tmp.txt', meta.vod.durationSec, ctx.signal, (f) =>
      ctx.progress(0.8 + f * 0.2, 'Preparing audio')
    )
    renameSync(join(ctx.dir, 'audio16k.tmp.wav'), wav)
    renameSync(join(ctx.dir, 'loudness.tmp.txt'), loud)
    const loudness = parseLoudnessLog(await readFile(loud, 'utf8'), meta.vod.durationSec)
    const muted = mergeRanges([...meta.mutedFromPlaylist, ...silentRanges(loudness)], 1)
    await writeJsonAtomic(join(ctx.dir, 'muted.json'), muted)
  }
}

// ---------------------------------------------------------------- transcribe

function transcriptDone(dir: string): boolean {
  return existsSync(join(dir, 'transcript.json'))
}

export interface TranscriptFile {
  language: string | null
  words: PackedWord[]
}

/** A chunk counts as done only if it was written in the current format. */
async function chunkDone(file: string): Promise<boolean> {
  if (!existsSync(file)) return false
  try {
    return (await readJson<{ v?: number }>(file)).v === CHUNK_FORMAT
  } catch {
    return false
  }
}

async function transcribe(ctx: StepContext): Promise<void> {
  if (transcriptDone(ctx.dir)) return
  const meta = await loadMeta(ctx.dir)
  const duration = meta.vod.durationSec
  const loudness = parseLoudnessLog(await readFile(join(ctx.dir, 'loudness.txt'), 'utf8'), duration)
  const muted = await readJson<Range[]>(join(ctx.dir, 'muted.json'))
  const chunks = planChunks(duration, loudness)
  const outDir = join(ctx.dir, 'transcript')
  mkdirSync(outDir, { recursive: true })

  const ffmpeg = ctx.tools.require('ffmpeg')
  const cuda = ctx.hw.whisper === 'cuda' ? ctx.tools.path('whisper-cuda') : null
  const cpu = ctx.tools.require('whisper-cpu')
  const large = ctx.tools.path('model-whisper-large')
  const small = ctx.tools.path('model-whisper-small')
  if (!large && !small) throw new UserError('The speech model is missing. Open setup to download it again.', { retryable: false })
  // The large model on the GPU; the small one on the CPU (the large one is far too slow there).
  const modelFor = (gpu: boolean): string => (gpu ? (large ?? small)! : (small ?? large)!)
  const vad = ctx.tools.path('model-vad')
  const root = ctx.paths.root
  const rel = (p: string): string => relative(root, p)

  let useGpu = !!cuda
  if (useGpu) {
    const free = await nvidiaFreeVramMb()
    if (free !== null && free < 2500) {
      ctx.log.warn(`only ${free} MB VRAM free; transcribing on the CPU`)
      useGpu = false
    }
  }
  const cpuThreads = Math.max(2, Math.min(8, ctx.hw.cpuThreads - 2))
  const langFile = join(outDir, 'language.txt')
  let language: string | null = existsSync(langFile) ? (await readFile(langFile, 'utf8')).trim() || null : null

  const release = await ctx.gpu.acquire(ctx.signal)
  try {
    for (let i = 0; i < chunks.length; i++) {
      throwIfAborted(ctx.signal)
      const chunk = chunks[i]!
      const name = `chunk-${String(i).padStart(3, '0')}`
      const done = join(outDir, `${name}.json`)
      if (await chunkDone(done)) continue
      const overallBase = i / chunks.length
      const report = (f: number): void => ctx.progress(overallBase + f / chunks.length, useGpu ? null : 'Using the processor (slower)')
      report(0)
      // Skip chunks that are entirely muted.
      const mutedSec = muted.reduce((s, m) => s + Math.max(0, Math.min(chunk.end, m.end) - Math.max(chunk.start, m.start)), 0)
      if (mutedSec >= chunk.end - chunk.start - 1) {
        await writeJsonAtomic(done, { v: CHUNK_FORMAT, range: chunk, words: [] })
        continue
      }
      const wav = join(outDir, `${name}.wav`)
      await cutWav(ffmpeg, root, rel(join(ctx.dir, 'audio16k.wav')), chunk.start, chunk.end - chunk.start, rel(wav), ctx.signal)
      const outBase = join(outDir, `${name}.raw`)
      const run = async (gpu: boolean): Promise<void> =>
        whisperChunk({
          whisper: gpu && cuda ? cuda : cpu,
          cwd: root,
          model: rel(modelFor(gpu)),
          vadModel: vad ? rel(vad) : null,
          audio: rel(wav),
          outBase: rel(outBase),
          language,
          threads: gpu ? 4 : cpuThreads,
          gpu,
          beam: gpu ? 5 : 1,
          signal: ctx.signal,
          onProgress: report
        })
      try {
        await run(useGpu)
      } catch (err) {
        if (isCancelled(err) || !useGpu) throw err
        ctx.log.warn('GPU transcription failed; switching to the CPU', err)
        useGpu = false
        await run(false)
      }
      const parsed = parseWhisperJson(await readJson<unknown>(`${outBase}.json`))
      if (!language && parsed.language) {
        language = parsed.language
        writeFileSync(langFile, language)
      }
      const placed = placeChunkWords(parsed.words, chunk)
      if (placed.dropped > 0) ctx.log.warn(`${name}: dropped ${placed.dropped} of ${parsed.words.length} words timed outside the chunk`)
      await writeJsonAtomic(done, { v: CHUNK_FORMAT, range: chunk, words: packWords(placed.words) })
      rmSync(`${outBase}.json`, { force: true })
      rmSync(wav, { force: true })
    }
  } finally {
    release()
  }

  const parts = await Promise.all(
    chunks.map(async (c, i) => {
      const j = await readJson<{ range: Range; words: PackedWord[] }>(join(outDir, `chunk-${String(i).padStart(3, '0')}.json`))
      return { range: c, words: unpackWords(j.words) }
    })
  )
  const words = mergeChunks(parts)
  const out: TranscriptFile = { language, words: packWords(words) }
  await writeJsonAtomic(join(ctx.dir, 'transcript.json'), out)
  // The 16 kHz copy is only needed for transcription (about 115 MB per hour).
  rmSync(join(ctx.dir, 'audio16k.wav'), { force: true })
  ctx.log.info(`transcribed ${words.length} words, language ${language ?? 'unknown'}`)
}

export async function loadWords(dir: string): Promise<{ language: string | null; words: Word[] }> {
  const t = await readJson<TranscriptFile>(join(dir, 'transcript.json'))
  return { language: t.language, words: unpackWords(t.words) }
}

// ---------------------------------------------------------------- moments

interface Pick {
  cand: Candidate
  refined: Refined | null
  window: Range
  title: string
  score: number
  strength: number
}

async function moments(ctx: StepContext): Promise<void> {
  const meta = await loadMeta(ctx.dir)
  const duration = meta.vod.durationSec
  const [chatText, loudText, transcript, muted] = await Promise.all([
    readFile(join(ctx.dir, 'chat.txt'), 'utf8'),
    readFile(join(ctx.dir, 'loudness.txt'), 'utf8'),
    loadWords(ctx.dir),
    readJson<Range[]>(join(ctx.dir, 'muted.json'))
  ])
  const messages = parseChatLog(chatText)
  const loudness = parseLoudnessLog(loudText, duration)
  const words = transcript.words
  const target = targetClipCount(duration)
  const candidates = findCandidates({ durationSec: duration, messages, loudness, words, muted }, { limit: Math.min(40, target * 2) })
  ctx.log.info(`${messages.length} chat messages, ${candidates.length} candidates, target ${target}`)

  const llm = await openLlm(ctx)
  let refined: (Refined | null)[] = candidates.map(() => null)
  let scanned: Pick[] = []
  try {
    if (llm) refined = await refineCandidates(ctx, llm, meta, candidates, messages, words, duration)
    const keptCount = candidates.filter((_, i) => refined[i]?.keep !== false).length
    // A quiet chat gives too few moments: let the model read the transcript too.
    if (llm && keptCount < target) {
      const avoid = [...muted, ...candidates.map((c) => c.window)]
      scanned = await scanTranscript(ctx, llm, meta, words, avoid, duration)
    }
  } finally {
    llm?.close()
  }

  let picks: Pick[] = candidates.map((cand, i) => {
    const r = refined[i] ?? null
    const window = r?.window ?? cand.window
    const score = combinedScore(cand.score, r?.rating ?? null)
    return { cand, refined: r, window, title: r?.title ?? fallbackTitle(words, window), score, strength: score }
  })
  const kept = picks.filter((p) => p.refined?.keep !== false)
  // If the model rejected nearly everything, trust the signals for a few.
  picks = kept.length >= Math.min(3, picks.length) ? kept : picks
  const chosen = selectNonOverlapping([...picks, ...scanned], target)
  if (chosen.length === 0) {
    ctx.store.replaceClips(ctx.job.id, [])
    throw new UserError('No stand-out moments were found in this VOD. Chat and audio stayed calm the whole time.', { retryable: false })
  }

  const defaultLayoutId = ctx.store.get<string>('defaultLayoutId')
  const clips: Clip[] = chosen.map((p, i) => ({
    id: randomUUID(),
    jobId: ctx.job.id,
    rank: i + 1,
    score: Math.round(p.score * 100) / 100,
    title: p.title,
    start: p.window.start,
    end: p.window.end,
    suggested: { ...p.window },
    source: null,
    status: 'pending',
    words: wordsIn(words, p.window.start - CLIP_PAD_SEC, p.window.end + CLIP_PAD_SEC),
    captions: { enabled: true, y: 0.72, uppercase: true },
    audio: 'original',
    musicPath: null,
    layoutId: defaultLayoutId && ctx.store.layout(defaultLayoutId) ? defaultLayoutId : null,
    formats: { vertical: true, horizontal: false },
    reason: p.cand.reasons.join(' · ')
  }))
  await writeJsonAtomic(join(ctx.dir, 'moments.json'), {
    candidates,
    refined,
    scanned: scanned.map((p) => ({ window: p.window, title: p.title, score: p.score })),
    chosen: clips.map((c) => c.id)
  })
  ctx.store.replaceClips(ctx.job.id, clips)
}

interface LlmSession {
  server: LlamaServer
  close: () => void
}

/** Starts the local language model, or returns null (not installed / failed). */
async function openLlm(ctx: StepContext): Promise<LlmSession | null> {
  const exe = ctx.tools.path('llama')
  const model = ctx.llmModelOverride ?? ctx.tools.path('model-llm-8b') ?? ctx.tools.path('model-llm-3b')
  if (!exe || !model) {
    ctx.log.info('language model not installed; using signals only')
    return null
  }
  const release = await ctx.gpu.acquire(ctx.signal)
  const server = new LlamaServer(exe, ctx.paths.root, relative(ctx.paths.root, model), ctx.hw.llm === 'vulkan')
  ctx.progress(0.02, 'Starting the language model')
  try {
    await server.start(ctx.signal)
  } catch (err) {
    server.stop()
    release()
    if (isCancelled(err)) throw err
    ctx.log.warn('language model failed to start; using signals only', err)
    return null
  }
  return {
    server,
    close: () => {
      server.stop()
      release()
    }
  }
}

async function ask(ctx: StepContext, llm: LlmSession, prompt: string): Promise<string> {
  return llm.server.complete(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ],
    ANSWER_SCHEMA,
    ctx.signal
  )
}

async function refineCandidates(
  ctx: StepContext,
  llm: LlmSession,
  meta: JobMeta,
  candidates: Candidate[],
  messages: ReturnType<typeof parseChatLog>,
  words: Word[],
  duration: number
): Promise<(Refined | null)[]> {
  const out: (Refined | null)[] = candidates.map(() => null)
  let failures = 0
  for (let i = 0; i < candidates.length; i++) {
    throwIfAborted(ctx.signal)
    ctx.progress(0.05 + (0.55 * i) / candidates.length, null)
    const c = candidates[i]!
    const range = excerptRange(c, duration)
    const excerpt = { offset: range.start, range, lines: excerptLines(words, range) }
    const chapter = meta.chapters.find((ch) => c.event >= ch.start && c.event < ch.end)?.title ?? null
    const prompt = buildPrompt({ title: meta.vod.title, channel: meta.vod.channel, chapter }, c, excerpt, topChat(messages, { start: c.peak - 12, end: c.peak + 5 }))
    try {
      const answer = await ask(ctx, llm, prompt)
      out[i] = parseAnswer(answer, excerpt, duration)
      if (!out[i]) ctx.log.warn('unusable model answer', answer.slice(0, 300))
    } catch (err) {
      if (isCancelled(err) || ctx.signal.aborted) throw new CancelledError()
      ctx.log.warn('model request failed', err)
      if (++failures >= 3) {
        ctx.log.warn('too many model failures; using signals for the rest')
        break
      }
    }
  }
  return out
}

/** Signal score given to moments found only in the transcript. */
const TRANSCRIPT_SIGNAL = 0.3
/** Transcript moments must be rated at least this high to be kept. */
const TRANSCRIPT_MIN_RATING = 6

async function scanTranscript(ctx: StepContext, llm: LlmSession, meta: JobMeta, words: Word[], avoid: Range[], duration: number): Promise<Pick[]> {
  const windows = scanWindows(duration, words, avoid).slice(0, 160)
  ctx.log.info(`scanning ${windows.length} transcript windows`)
  const out: Pick[] = []
  let failures = 0
  for (let i = 0; i < windows.length; i++) {
    throwIfAborted(ctx.signal)
    ctx.progress(0.6 + (0.4 * i) / windows.length, 'Reading the transcript')
    const range = windows[i]!
    const excerpt = { offset: range.start, range, lines: excerptLines(words, range) }
    const chapter = meta.chapters.find((ch) => range.start >= ch.start && range.start < ch.end)?.title ?? null
    try {
      const r = parseAnswer(await ask(ctx, llm, buildScanPrompt({ title: meta.vod.title, channel: meta.vod.channel, chapter }, excerpt)), excerpt, duration)
      if (!r || !r.keep || r.rating < TRANSCRIPT_MIN_RATING) continue
      const score = combinedScore(TRANSCRIPT_SIGNAL, r.rating)
      const cand: Candidate = {
        peak: (r.window.start + r.window.end) / 2,
        event: r.window.start,
        window: r.window,
        strength: score,
        score: TRANSCRIPT_SIGNAL,
        chatZ: 0,
        audioZ: 0,
        reasons: ['Transcript']
      }
      out.push({ cand, refined: r, window: r.window, title: r.title ?? fallbackTitle(words, r.window), score, strength: score })
    } catch (err) {
      if (isCancelled(err) || ctx.signal.aborted) throw new CancelledError()
      ctx.log.warn('model request failed', err)
      if (++failures >= 3) break
    }
  }
  return out
}

// ---------------------------------------------------------------- clips

async function clipsStep(ctx: StepContext): Promise<void> {
  const clips = ctx.store.clips(ctx.job.id)
  const meta = await loadMeta(ctx.dir)
  const ytdlp = ctx.tools.require('yt-dlp')
  const ffmpeg = ctx.tools.require('ffmpeg')
  const ffprobe = ffmpeg.replace(/ffmpeg\.exe$/i, 'ffprobe.exe')
  const fullAudio = findAudioFile(ctx.dir)
  const dir = join(ctx.dir, 'clips')
  mkdirSync(dir, { recursive: true })

  for (let i = 0; i < clips.length; i++) {
    throwIfAborted(ctx.signal)
    const clip = clips[i]!
    const file = join(dir, `${clip.id}.mp4`)
    if (clip.source && existsSync(file)) continue
    const report = (f: number): void => ctx.progress((i + f) / clips.length, `Clip ${i + 1} of ${clips.length}`)
    report(0)
    const want = { start: Math.max(0, clip.start - CLIP_PAD_SEC), end: Math.min(meta.vod.durationSec, clip.end + CLIP_PAD_SEC) }
    rmSync(file, { force: true })
    await downloadSection(ytdlp, ffmpeg, ctx.job.url, want.start, want.end, join(dir, `${clip.id}.%(ext)s`), ctx.signal, (f) => report(f * 0.9))
    if (!existsSync(file)) {
      const other = readdirSync(dir).find((f) => f.startsWith(clip.id) && !f.endsWith('.part'))
      if (!other) throw new UserError('A clip download did not produce a file. Try again.')
      renameSync(join(dir, other), file)
    }
    const info = await probeMedia(ffprobe, file, ctx.signal)
    let start = want.start
    if (fullAudio && info.hasAudio) {
      start = await alignClip(ffmpeg, fullAudio, file, want.start, info.duration, ctx.signal).catch((err) => {
        if (isCancelled(err)) throw err
        ctx.log.warn('alignment failed; using the requested start', err)
        return want.start
      })
    }
    const source = { start: Math.round(start * 1000) / 1000, end: Math.round((start + info.duration) * 1000) / 1000 }
    ctx.store.saveClip({ ...clip, source, start: Math.max(clip.start, source.start), end: Math.min(clip.end, source.end) })
    report(1)
  }
}

/** Where the clip file really starts in VOD time, matched on audio. */
export async function alignClip(ffmpeg: string, fullAudio: string, clipFile: string, expected: number, clipDuration: number, signal: AbortSignal): Promise<number> {
  const probeLen = Math.min(20, clipDuration)
  const search = 8
  const refStart = Math.max(0, expected - search)
  const [ref, probe] = await Promise.all([
    extractPcm(ffmpeg, fullAudio, refStart, probeLen + 2 * search, signal),
    extractPcm(ffmpeg, clipFile, 0, probeLen, signal)
  ])
  const { lag, score } = bestLag(envelope(pcm16ToFloat(ref), 8000), envelope(pcm16ToFloat(probe), 8000))
  if (score < 0.6) return expected
  return refStart + lag * 0.01
}

// ---------------------------------------------------------------- registry

export const STEPS: Record<StepId, (ctx: StepContext) => Promise<void>> = {
  metadata,
  chat,
  audio,
  transcribe,
  moments,
  clips: clipsStep
}

/** Steps that talk to the network and are worth retrying automatically. */
export const NETWORK_STEPS: ReadonlySet<StepId> = new Set(['metadata', 'chat', 'audio', 'clips'])
