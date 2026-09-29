// The seven pipeline steps. Each one is idempotent: it checks what is already
// on disk and continues from there, so a crash or reboot loses at most a
// little work (one transcription chunk, one clip's captions, one clip
// download).

import { existsSync, mkdirSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { randomUUID } from 'node:crypto'
import type { Clip, HardwareProfile, JobSummary, MomentSource, Range, StepId, VodInfo, Word } from '@shared/types'
import { DEFAULT_CAPTION_STYLE, isCaptionStyleId } from '@shared/captionStyles'
import { chatIn } from '@shared/chatOverlay'
import { needsClipCaptionPass } from '@shared/hardware'
import { collapseLoops } from '@shared/transcriptLoops'
import { isStretchedWord, repairWordTimings } from '@shared/wordTiming'
import { bestLag, envelope, pcm16ToFloat } from '../core/align'
import { parseChatLog } from '../core/chat'
import { clipCaptionRange, fastChunkRanges, overlapsAnyRange, resolveClipCaptionWords, shouldSkipClipCaptions, type ChunkRecord } from '../core/clipCaptions'
import {
  ANSWER_SCHEMA,
  buildPrompt,
  buildScanPrompt,
  combinedScore,
  combineSamples,
  excerptLines,
  excerptRange,
  parseAnswer,
  ratingFactor,
  scanWindows,
  SYSTEM_PROMPT,
  topChat,
  type Excerpt,
  type Refined
} from '../core/llmPrompt'
import { clipFacts, decideStructureHeuristically } from '../core/clipFacts'
import { mergeRanges, parseLoudnessLog } from '../core/media'
import { fallbackTitle, findCandidates, maxClipCount, MIN_CLIPS, scoreToStrength, selectByQuality, type Candidate } from '../core/moments'
import { pickStructure } from '../core/structurePick'
import { pickStructureWithLlm, STRUCTURE_SYSTEM_PROMPT } from '../core/structureLlm'
import { computeSignals } from '../core/structureSignals'
import { deriveTasteAdjustments, type TasteAdjustments } from '../core/taste'
import { assessSpeech, findBadTranscriptRanges, judgeSpeech } from '../core/transcriptQuality'
import { CHUNK_FORMAT, mergeChunks, packWords, parseWhisperJson, placeChunkWords, planChunks, repairChunkWordTimings, unpackWords, wordsIn, type PackedWord } from '../core/transcript'
import type { AppPaths } from '../paths'
import type { Store } from '../store'
import { nvidiaFreeVramMb } from '../tools/gpu'
import type { ToolRegistry } from '../tools/registry'
import { CancelledError, UserError, isCancelled, throwIfAborted } from '../util/errors'
import type { Logger } from '../util/log'
import { downloadChat, LlamaServer, whisperChunk } from './ai'
import type { GpuLock } from './gpuLock'
import { cutAudioSegment, cutWav, extractPcm, fetchMutedRanges, prepareAudio, probeMedia, silentRanges } from './media'
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

/** GPU failures after which the rest of the VOD is transcribed on the CPU. */
const MAX_GPU_FAILURES = 2

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
  const gpuWhisper = ctx.hw.whisper === 'cuda' ? ctx.tools.path('whisper-cuda') : ctx.hw.whisper === 'vulkan' ? ctx.tools.path('whisper-vulkan') : null
  const cpu = ctx.tools.require('whisper-cpu')
  const large = ctx.tools.path('model-whisper-large')
  const small = ctx.tools.path('model-whisper-small')
  if (!large && !small) throw new UserError('The speech model is missing. Open setup to download it again.', { retryable: false })
  // The large model on the GPU; the small one on the CPU (the large one is far too slow there).
  const modelFor = (gpu: boolean): string => (gpu ? (large ?? small)! : (small ?? large)!)
  const vad = ctx.tools.path('model-vad')
  const root = ctx.paths.root
  const rel = (p: string): string => relative(root, p)

  let useGpu = !!gpuWhisper
  let gpuFailures = 0
  // nvidia-smi is the only free-memory reading we have; other cards are not checked.
  if (useGpu && ctx.hw.whisper === 'cuda') {
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
      let onGpu = useGpu
      const report = (f: number): void => ctx.progress(overallBase + f / chunks.length, onGpu ? null : 'Using the processor (slower)')
      report(0)
      // Skip chunks that are entirely muted.
      const mutedSec = muted.reduce((s, m) => s + Math.max(0, Math.min(chunk.end, m.end) - Math.max(chunk.start, m.start)), 0)
      if (mutedSec >= chunk.end - chunk.start - 1) {
        await writeJsonAtomic(done, { v: CHUNK_FORMAT, range: chunk, sharp: true, words: [] })
        continue
      }
      const wav = join(outDir, `${name}.wav`)
      await cutWav(ffmpeg, root, rel(join(ctx.dir, 'audio16k.wav')), chunk.start, chunk.end - chunk.start, rel(wav), ctx.signal)
      const outBase = join(outDir, `${name}.raw`)
      const run = async (gpu: boolean): Promise<void> => {
        onGpu = gpu
        return whisperChunk({
          whisper: gpu && gpuWhisper ? gpuWhisper : cpu,
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
      }
      try {
        await run(useGpu)
      } catch (err) {
        if (isCancelled(err) || !useGpu) throw err
        // A one-off failure (a game briefly holding the VRAM) should not send
        // the rest of a long VOD to the much slower CPU; a repeated one does.
        gpuFailures++
        ctx.log.warn(`GPU transcription failed (${gpuFailures} of ${MAX_GPU_FAILURES}); this chunk goes to the CPU`, err)
        if (gpuFailures >= MAX_GPU_FAILURES) useGpu = false
        await run(false)
      }
      const parsed = parseWhisperJson(await readJson<unknown>(`${outBase}.json`))
      if (!language && parsed.language) {
        language = parsed.language
        writeFileSync(langFile, language)
      }
      let words = parsed.words
      if (words.some((w) => isStretchedWord(w))) {
        // The chunk's own WAV is still on disk (chunk-relative time, matching
        // whisper's words): find where each stretched word's speech really is.
        try {
          const pcm = await extractPcm(ffmpeg, wav, 0, chunk.end - chunk.start, ctx.signal)
          const env = envelope(pcm16ToFloat(pcm), 8000)
          words = repairChunkWordTimings(words, env, 0.01)
        } catch (err) {
          if (isCancelled(err)) throw err
          ctx.log.warn(`${name}: could not read a voice envelope for stretched words`, err)
        }
      }
      const placed = placeChunkWords(words, chunk)
      if (placed.dropped > 0) ctx.log.warn(`${name}: dropped ${placed.dropped} of ${parsed.words.length} words timed outside the chunk`)
      // Recorded so the clip caption pass knows which stretches still need the large model.
      await writeJsonAtomic(done, { v: CHUNK_FORMAT, range: chunk, sharp: onGpu && !!large, words: packWords(placed.words) })
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
  // Envelope repair runs per chunk above; anything it could not place (no
  // audio, or too wide a match) gets a last pass with the text heuristic.
  const words = repairWordTimings(mergeChunks(parts))
  const out: TranscriptFile = { language, words: packWords(words) }
  await writeJsonAtomic(join(ctx.dir, 'transcript.json'), out)
  // The 16 kHz copy is only needed for transcription (about 115 MB per hour).
  rmSync(join(ctx.dir, 'audio16k.wav'), { force: true })
  ctx.log.info(`transcribed ${words.length} words, language ${language ?? 'unknown'}`)
}

export async function loadWords(dir: string): Promise<{ language: string | null; words: Word[] }> {
  const t = await readJson<TranscriptFile>(join(dir, 'transcript.json'))
  // Idempotent: a transcript written before this fix gets repaired here too,
  // so moments (which snaps cuts to pauses between words) sees them fixed.
  return { language: t.language, words: repairWordTimings(unpackWords(t.words)) }
}

// ---------------------------------------------------------------- moments

interface Pick {
  cand: Candidate
  refined: Refined | null
  window: Range
  title: string
  /** 0..1, shown to him and blended with the model's rating when present. */
  score: number
  /**
   * Raw signal strength scaled by the model's rating when there is one (see
   * `ratingFactor`), used only to rank and quality-gate the final selection.
   * Kept separate from `score`: once `score` is bounded to 0..1 (see
   * `strengthToScore`), a very strong candidate cannot be told apart from a
   * merely decent one, and a quality bar relative to the strongest candidate
   * needs that difference to mean anything.
   */
  strength: number
  /** Copied from `cand`: which signals quality-gating treats this as coming from. */
  chatZ: number
  audioZ: number
  /** The model's 1..10 rating, or null with no model -- see `selectByQuality`. */
  rating: number | null
}

/** Which signal a candidate mainly came from, for taste learning. */
function sourceOf(cand: Candidate): MomentSource {
  if (cand.reasons.includes('Transcript')) return 'transcript'
  return cand.chatZ > 0 ? 'chat' : 'audio'
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
  // Whisper sometimes loops on silence or music ("Tired Tired Tired", a
  // sentence repeated for a minute straight): find where that happened so
  // those stretches never drive a candidate or end up in a title, and use a
  // version with the loops collapsed to one occurrence for everything a
  // human or the language model reads.
  const badTranscript = findBadTranscriptRanges(words)
  const cleanWords = collapseLoops(words)
  // Ceiling only: the finder never fills up to this, it just never goes past
  // it. How many clips actually come out is decided by quality, below.
  const ceiling = maxClipCount(duration)
  // How his past accepts/rejects and trims have nudged the defaults; identical
  // to today's behaviour until there is real history to learn from.
  const adjustments = deriveTasteAdjustments(ctx.store.getTasteHistory())
  const rawCandidates = findCandidates({ durationSec: duration, messages, loudness, words, muted }, { limit: Math.min(40, ceiling * 2) }, adjustments)
  // Drop candidates whose transcript is mostly hallucinated or empty, unless
  // chat or loudness alone are strong enough that something real clearly
  // happened -- then the candidate is kept but marked, so its title comes
  // from chat and reaction, not from looped nonsense.
  const candidates: Candidate[] = []
  let droppedForSpeech = 0
  for (const cand of rawCandidates) {
    // Judged over the same excerpt the language model would see (wider than
    // the eventual clip window), since that is what a title would be drawn
    // from and what decides whether this is worth asking the model at all.
    const assessment = assessSpeech(excerptRange(cand, duration), words, badTranscript)
    const verdict = judgeSpeech(assessment, cand.chatZ, cand.audioZ)
    if (verdict === 'drop') {
      droppedForSpeech++
      continue
    }
    candidates.push(verdict === 'keep_no_speech' ? { ...cand, reasons: [...cand.reasons, 'No speech'] } : cand)
  }
  if (droppedForSpeech > 0) ctx.log.info(`dropped ${droppedForSpeech} candidates with no reliable speech`)
  ctx.log.info(`${messages.length} chat messages, ${candidates.length} candidates, ceiling ${ceiling}`)

  const llm = await openLlm(ctx)
  try {
    let refined: (Refined | null)[] = candidates.map(() => null)
    let scanned: Pick[] = []
    if (llm) refined = await refineCandidates(ctx, llm, meta, candidates, messages, cleanWords, duration)
    const keptCount = candidates.filter((_, i) => refined[i]?.keep !== false).length
    // A quiet chat gives too few moments: let the model read the transcript too.
    if (llm && keptCount < ceiling) {
      const avoid = [...muted, ...candidates.map((c) => c.window)]
      scanned = await scanTranscript(ctx, llm, meta, cleanWords, badTranscript, avoid, duration, adjustments)
    }

    let picks: Pick[] = candidates.map((cand, i) => {
      const r = refined[i] ?? null
      const window = r?.window ?? cand.window
      const rating = r?.rating ?? null
      const score = combinedScore(cand.score, rating)
      return {
        cand,
        refined: r,
        window,
        title: r?.title ?? fallbackTitle(cleanWords, window),
        score,
        strength: cand.strength * ratingFactor(rating),
        chatZ: cand.chatZ,
        audioZ: cand.audioZ,
        rating
      }
    })
    const kept = picks.filter((p) => p.refined?.keep !== false)
    // If the model rejected nearly everything, trust the signals for a few.
    picks = kept.length >= Math.min(3, picks.length) ? kept : picks
    const chosen = selectByQuality([...picks, ...scanned], MIN_CLIPS, ceiling)
    if (chosen.length === 0) {
      ctx.store.replaceClips(ctx.job.id, [])
      throw new UserError('No stand-out moments were found in this VOD. Chat and audio stayed calm the whole time.', { retryable: false })
    }

    const defaultLayoutId = ctx.store.get<string>('defaultLayoutId')
    const storedStyle = ctx.store.get<string>('defaultCaptionStyleId')
    const defaultStyleId = storedStyle && isCaptionStyleId(storedStyle) ? storedStyle : DEFAULT_CAPTION_STYLE
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
      captions: { enabled: true, y: 0.72, uppercase: true, styleId: defaultStyleId },
      chatMessages: chatIn(messages, p.window.start - CLIP_PAD_SEC, p.window.end + CLIP_PAD_SEC),
      chatOverlay: false,
      audio: 'original',
      musicPath: null,
      layoutId: defaultLayoutId && ctx.store.layout(defaultLayoutId) ? defaultLayoutId : null,
      formats: { vertical: true, horizontal: false },
      reason: p.cand.reasons.join(' · '),
      signals: { chatZ: p.cand.chatZ, audioZ: p.cand.audioZ, score: p.cand.score, rating: p.refined?.rating ?? null, source: sourceOf(p.cand) },
      structureDecision: null,
      autoEdit: true
    }))

    // The one automatic re-edit structure for each clip, while the language
    // model (if any) is still running -- reusing it here instead of loading a
    // second one later, honouring the one-model-at-a-time GPU lock. Without
    // it, the heuristic alone decides; either way this never blocks a clip
    // from being reviewed (a request that fails just falls back, see
    // `pickStructureWithLlm`).
    for (const clip of clips) {
      throwIfAborted(ctx.signal)
      const signals = computeSignals(clipFacts(clip, loudness, 0))
      clip.structureDecision = llm
        ? await pickStructureWithLlm({ signals, words: clip.words, chatMessages: clip.chatMessages, clipStartSec: clip.start }, (prompt, schema) =>
            llm.server.complete([{ role: 'system', content: STRUCTURE_SYSTEM_PROMPT }, { role: 'user', content: prompt }], schema, ctx.signal)
          )
        : pickStructure(signals, clip.words, clip.start)
    }

    await writeJsonAtomic(join(ctx.dir, 'moments.json'), {
      candidates,
      refined,
      scanned: scanned.map((p) => ({ window: p.window, title: p.title, score: p.score })),
      chosen: clips.map((c) => c.id)
    })
    ctx.store.replaceClips(ctx.job.id, clips)
  } finally {
    llm?.close()
  }
}

interface LlmSession {
  server: LlamaServer
  close: () => void
  /**
   * Ask twice and keep a candidate only if both agree (see `combineSamples`):
   * benchmarked for the Qwen3.5 9B tier only, so only set when that is the
   * model actually running. The 3B tier, and a leftover Ministral 8B still
   * serving during the swap (see `tools/llmMigration.ts`), keep one sample.
   */
  twoSample: boolean
}

/** A second sample's sampling, distinct enough from the default request to be a real second opinion. */
const SECOND_SAMPLE = { temperature: 0.6, seed: 7919 }

/** Starts the local language model, or returns null (not installed / failed). */
async function openLlm(ctx: StepContext): Promise<LlmSession | null> {
  const exe = ctx.tools.path('llama')
  const qwenModel = ctx.tools.path('model-llm-9b')
  const model = ctx.llmModelOverride ?? qwenModel ?? ctx.tools.path('model-llm-8b') ?? ctx.tools.path('model-llm-3b')
  if (!exe || !model) {
    ctx.log.info('language model not installed; using signals only')
    return null
  }
  const twoSample = !ctx.llmModelOverride && model === qwenModel
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
    twoSample,
    close: () => {
      server.stop()
      release()
    }
  }
}

async function ask(ctx: StepContext, llm: LlmSession, prompt: string, sample: 0 | 1 = 0): Promise<string> {
  return llm.server.complete(
    [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: prompt }
    ],
    ANSWER_SCHEMA,
    ctx.signal,
    sample === 1 ? SECOND_SAMPLE : undefined
  )
}

/**
 * One sample for the 3B tier, or two independent samples combined (see
 * `combineSamples`) for the Qwen tier. The second request is skipped when it
 * cannot change the outcome: an unusable first answer makes the pair null
 * anyway, and with `rejectIsFinal` (a caller that throws rejected answers
 * away) a first "no" already decides it, since the pair only keeps when both do.
 */
async function askAndParse(
  ctx: StepContext,
  llm: LlmSession,
  prompt: string,
  excerpt: Excerpt,
  duration: number,
  rejectIsFinal = false
): Promise<Refined | null> {
  const first = parseAnswer(await ask(ctx, llm, prompt, 0), excerpt, duration)
  if (!llm.twoSample || !first || (rejectIsFinal && !first.keep)) return first
  const second = parseAnswer(await ask(ctx, llm, prompt, 1), excerpt, duration)
  return combineSamples(first, second)
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
      out[i] = await askAndParse(ctx, llm, prompt, excerpt, duration)
      if (!out[i]) ctx.log.warn('unusable model answer')
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

async function scanTranscript(
  ctx: StepContext,
  llm: LlmSession,
  meta: JobMeta,
  words: Word[],
  badTranscript: Range[],
  avoid: Range[],
  duration: number,
  adjustments: TasteAdjustments
): Promise<Pick[]> {
  const windows = scanWindows(duration, words, avoid).slice(0, 160)
  ctx.log.info(`scanning ${windows.length} transcript windows`)
  const transcriptSignal = TRANSCRIPT_SIGNAL * adjustments.transcriptWeight
  const out: Pick[] = []
  let failures = 0
  for (let i = 0; i < windows.length; i++) {
    throwIfAborted(ctx.signal)
    ctx.progress(0.6 + (0.4 * i) / windows.length, 'Reading the transcript')
    const range = windows[i]!
    // A scanned window has no chat or loudness backing it up, so unlike a
    // found candidate it is never kept anyway once it looks hallucinated --
    // skip it before it ever reaches the model.
    if (assessSpeech(range, words, badTranscript).noSpeech) continue
    const excerpt = { offset: range.start, range, lines: excerptLines(words, range) }
    const chapter = meta.chapters.find((ch) => range.start >= ch.start && range.start < ch.end)?.title ?? null
    try {
      const prompt = buildScanPrompt({ title: meta.vod.title, channel: meta.vod.channel, chapter }, excerpt)
      const r = await askAndParse(ctx, llm, prompt, excerpt, duration, true)
      if (!r || !r.keep || r.rating < TRANSCRIPT_MIN_RATING) continue
      const score = combinedScore(transcriptSignal, r.rating)
      // The scan gives a fixed nominal signal, not a z-score; scoreToStrength
      // puts it on the same raw scale as chat- and audio-backed candidates
      // so the quality bar can compare them fairly. It already only reaches
      // here at or above TRANSCRIPT_MIN_RATING, but still scales with rating
      // like every other candidate.
      const strength = scoreToStrength(transcriptSignal) * ratingFactor(r.rating)
      const cand: Candidate = {
        peak: (r.window.start + r.window.end) / 2,
        event: r.window.start,
        window: r.window,
        strength,
        score: transcriptSignal,
        chatZ: 0,
        audioZ: 0,
        reasons: ['Transcript']
      }
      out.push({ cand, refined: r, window: r.window, title: r.title ?? fallbackTitle(words, r.window), score, strength, chatZ: 0, audioZ: 0, rating: r.rating })
    } catch (err) {
      if (isCancelled(err) || ctx.signal.aborted) throw new CancelledError()
      ctx.log.warn('model request failed', err)
      if (++failures >= 3) break
    }
  }
  return out
}

// ------------------------------------------------------------- clip captions

/** Marks one clip's re-transcription attempt done (success or accepted fallback), so a crash resumes per clip, not from the top of the step. */
function clipCaptionMarker(dir: string, clipId: string): string {
  return join(dir, 'clipCaptions', `${clipId}.done`)
}

/** What the transcribe step recorded for each chunk, in order. Empty when there is no transcript folder. */
async function readChunkRecords(dir: string): Promise<ChunkRecord[]> {
  const folder = join(dir, 'transcript')
  if (!existsSync(folder)) return []
  const files = readdirSync(folder)
    .filter((f) => /^chunk-\d+\.json$/.test(f))
    .sort()
  const out: ChunkRecord[] = []
  for (const f of files) {
    try {
      const j = await readJson<{ range?: Range; sharp?: boolean }>(join(folder, f))
      if (j.range) out.push({ range: j.range, sharp: j.sharp })
    } catch {
      // An unreadable chunk record counts as unknown, which the caller treats as not sharp.
      return []
    }
  }
  return out
}

/**
 * Re-transcribes each kept clip's own audio range with the large model,
 * which is far too slow for the whole VOD on the CPU but easily affordable on
 * a clip. NVIDIA machines already transcribed the whole VOD with the large
 * model in the `transcribe` step, so there is nothing to sharpen there. On
 * Vulkan the whole VOD normally ran the large model too; only the clips that
 * touch a stretch that fell back to the CPU (or that has no record, from a job
 * started before the record existed) are re-transcribed.
 */
async function clipCaptions(ctx: StepContext): Promise<void> {
  const records = ctx.hw.whisper === 'vulkan' ? await readChunkRecords(ctx.dir) : []
  const fast = fastChunkRanges(records)
  if (!needsClipCaptionPass(ctx.hw, records.length > 0 && fast.length === 0)) return
  const large = ctx.tools.path('model-whisper-large')
  if (!large) {
    ctx.log.warn('the sharper speech model is missing; keeping the fast-pass captions')
    return
  }
  const fullAudio = findAudioFile(ctx.dir)
  if (!fullAudio) {
    ctx.log.warn('the VOD audio is gone; keeping the fast-pass captions')
    return
  }
  const meta = await loadMeta(ctx.dir)
  const duration = meta.vod.durationSec
  const clips = ctx.store
    .clips(ctx.job.id)
    .filter((c) => !shouldSkipClipCaptions(c))
    .filter((c) => ctx.hw.whisper !== 'vulkan' || records.length === 0 || overlapsAnyRange(clipCaptionRange(c, duration, CLIP_PAD_SEC), fast))
  if (clips.length === 0) return

  const ffmpeg = ctx.tools.require('ffmpeg')
  const cpu = ctx.tools.require('whisper-cpu')
  const gpuWhisper = ctx.hw.whisper === 'vulkan' ? ctx.tools.path('whisper-vulkan') : null
  const vad = ctx.tools.path('model-vad')
  const root = ctx.paths.root
  const rel = (p: string): string => relative(root, p)
  const cpuThreads = Math.max(2, Math.min(8, ctx.hw.cpuThreads - 2))
  const langFile = join(ctx.dir, 'transcript', 'language.txt')
  const language = existsSync(langFile) ? (await readFile(langFile, 'utf8')).trim() || null : null
  const outDir = join(ctx.dir, 'clipCaptions')
  mkdirSync(outDir, { recursive: true })

  let failures = 0
  let useGpu = !!gpuWhisper
  let gpuFailures = 0
  const release = await ctx.gpu.acquire(ctx.signal)
  try {
    for (let i = 0; i < clips.length; i++) {
      throwIfAborted(ctx.signal)
      const clip = clips[i]!
      const marker = clipCaptionMarker(ctx.dir, clip.id)
      if (existsSync(marker)) continue
      const report = (f: number): void => ctx.progress((i + f) / clips.length, `Sharpening captions (clip ${i + 1} of ${clips.length})`)
      report(0)
      const range = clipCaptionRange(clip, duration, CLIP_PAD_SEC)
      const wav = join(outDir, `${clip.id}.wav`)
      const outBase = join(outDir, `${clip.id}.raw`)
      try {
        await cutAudioSegment(ffmpeg, root, rel(fullAudio), range.start, range.end - range.start, rel(wav), ctx.signal)
        const run = (gpu: boolean): Promise<void> =>
          whisperChunk({
            whisper: gpu && gpuWhisper ? gpuWhisper : cpu,
            cwd: root,
            model: rel(large),
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
          gpuFailures++
          ctx.log.warn(`GPU re-transcription failed (${gpuFailures} of ${MAX_GPU_FAILURES}); this clip goes to the CPU`, err)
          if (gpuFailures >= MAX_GPU_FAILURES) useGpu = false
          await run(false)
        }
        const parsed = parseWhisperJson(await readJson<unknown>(`${outBase}.json`))
        let words = parsed.words
        if (words.some((w) => isStretchedWord(w))) {
          try {
            const pcm = await extractPcm(ffmpeg, wav, 0, range.end - range.start, ctx.signal)
            const env = envelope(pcm16ToFloat(pcm), 8000)
            words = repairChunkWordTimings(words, env, 0.01)
          } catch (err) {
            if (isCancelled(err)) throw err
            ctx.log.warn(`clip ${clip.id}: could not read a voice envelope for stretched words`, err)
          }
        }
        const placed = placeChunkWords(words, range).words
        const final = repairWordTimings(resolveClipCaptionWords(clip.words, placed))
        ctx.store.saveClip({ ...clip, words: final, structureDecision: decideStructureHeuristically({ ...clip, words: final }, null, 0, clip.structureDecision) })
      } catch (err) {
        if (isCancelled(err)) throw err
        failures++
        ctx.log.warn(`clip ${clip.id}: re-transcription failed; keeping the fast-pass captions`, err)
      } finally {
        rmSync(wav, { force: true })
        rmSync(`${outBase}.json`, { force: true })
      }
      writeFileSync(marker, '')
      report(1)
    }
  } finally {
    release()
  }
  if (clips.length > 0 && failures === clips.length) ctx.log.warn('could not sharpen captions for any clip; the fast-pass captions were kept')
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

  // A section download is one slow ffmpeg connection plus yt-dlp's own
  // start-up, so a few at once finish much sooner. Kept small so Twitch
  // does not start refusing requests.
  const fractions: number[] = clips.map((c) => (c.source && existsSync(join(dir, `${c.id}.mp4`)) ? 1 : 0))
  let finished = fractions.filter((f) => f === 1).length
  const report = (i: number, f: number): void => {
    fractions[i] = f
    ctx.progress(fractions.reduce((a, b) => a + b, 0) / Math.max(1, clips.length), `Clip ${Math.min(clips.length, finished + 1)} of ${clips.length}`)
  }
  const failed = new AbortController()
  const signal = AbortSignal.any([ctx.signal, failed.signal])
  const one = async (i: number): Promise<void> => {
    const clip = clips[i]!
    const file = join(dir, `${clip.id}.mp4`)
    if (clip.source && existsSync(file)) return
    report(i, 0)
    const want = { start: Math.max(0, clip.start - CLIP_PAD_SEC), end: Math.min(meta.vod.durationSec, clip.end + CLIP_PAD_SEC) }
    rmSync(file, { force: true })
    await downloadSection(ytdlp, ffmpeg, ctx.job.url, want.start, want.end, join(dir, `${clip.id}.%(ext)s`), signal, (f) => report(i, f * 0.9))
    if (!existsSync(file)) {
      const other = readdirSync(dir).find((f) => f.startsWith(clip.id) && !f.endsWith('.part'))
      if (!other) throw new UserError('A clip download did not produce a file. Try again.')
      renameSync(join(dir, other), file)
    }
    const info = await probeMedia(ffprobe, file, signal)
    let start = want.start
    if (fullAudio && info.hasAudio) {
      start = await alignClip(ffmpeg, fullAudio, file, want.start, info.duration, signal, ctx.log).catch((err) => {
        if (isCancelled(err)) throw err
        ctx.log.warn('alignment failed; using the requested start', err)
        return want.start
      })
    }
    const source = { start: Math.round(start * 1000) / 1000, end: Math.round((start + info.duration) * 1000) / 1000 }
    // Each download saves only its own clip, read fresh from the list above;
    // no other step writes clips while this one runs.
    ctx.store.saveClip({ ...clip, source, start: Math.max(clip.start, source.start), end: Math.min(clip.end, source.end) })
    finished++
    report(i, 1)
  }
  let next = 0
  let firstError: unknown = null
  const worker = async (): Promise<void> => {
    while (next < clips.length && !signal.aborted) {
      const i = next++
      try {
        await one(i)
      } catch (err) {
        // Stop the other downloads too; the step's retry picks up what is left.
        if (firstError === null) firstError = err
        failed.abort()
        return
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(CLIP_DOWNLOADS_AT_ONCE, clips.length) }, worker))
  throwIfAborted(ctx.signal)
  if (firstError !== null) throw firstError
}

/** How many clip videos download at the same time. */
const CLIP_DOWNLOADS_AT_ONCE = 3

/** Where the clip file really starts in VOD time, matched on audio. */
export async function alignClip(
  ffmpeg: string,
  fullAudio: string,
  clipFile: string,
  expected: number,
  clipDuration: number,
  signal: AbortSignal,
  log?: { info: (...p: unknown[]) => void }
): Promise<number> {
  const probeLen = Math.min(20, clipDuration)
  // A copied HLS section starts on the segment boundary at or before the
  // requested time, and Twitch segments are up to about 10 s long.
  const search = 14
  const refStart = Math.max(0, expected - search)
  const [ref, probe] = await Promise.all([
    extractPcm(ffmpeg, fullAudio, refStart, probeLen + 2 * search, signal),
    extractPcm(ffmpeg, clipFile, 0, probeLen, signal)
  ])
  const { lag, score } = bestLag(envelope(pcm16ToFloat(ref), 8000), envelope(pcm16ToFloat(probe), 8000))
  const found = refStart + lag * 0.01
  log?.info(`aligned at ${(found - expected).toFixed(2)} s from the request (match ${score.toFixed(2)})`)
  if (score < 0.6) return expected
  return found
}

// ---------------------------------------------------------------- registry

export const STEPS: Record<StepId, (ctx: StepContext) => Promise<void>> = {
  metadata,
  chat,
  audio,
  transcribe,
  moments,
  clipCaptions,
  clips: clipsStep
}

/** Steps that talk to the network and are worth retrying automatically. */
export const NETWORK_STEPS: ReadonlySet<StepId> = new Set(['metadata', 'chat', 'audio', 'clips'])
