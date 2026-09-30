// A per-clip score for "best moments first": orders a job's clips and picks
// the clearly strong ones to start out accepted. It is not a view prediction;
// nothing predicts how a platform will treat a clip (`docs/auto-edit-research.md`
// section 4.8 idea 1). It ranks what viewers themselves call epic, using only
// what is measured locally. Pure and deterministic, no language model needed.
//
// Weights, all in `VIRALITY` below, from the research table (section 3):
//  - evidence (0.55): chat spike size, distinct chatters and distinct people
//    posting reaction tokens (factor 1, evidence B: chat and emotes are the
//    strongest signal for epic moments) and loudness peak (factor 3), combined
//    so either alone can carry a clip: a loud reaction chat ignored still
//    counts (small chats, silent funny moments), and agreement lifts it.
//  - payoff (0.15): a clear setup, then the reaction, not at the very end, and
//    a quotable line when there is speech (factors 5 and 6; peak-end).
//  - hook (0.10) and content floor (0.10): from the rule engine's `editPlan`
//    (factors 4 and 9); a clip without a plan gets a neutral middle value.
//  - cold open (0.06) and loop (0.04): small bonuses only, no platform data
//    says they raise reach (D grade).
// A language model's keep vote (its 1-10 rating, present only when it ran and
// its two samples agreed) blends in at `llmWeight`; the local taste model
// nudges the evidence part by how often he kept clips of that source.

import type { Clip, ClipVirality } from '@shared/types'
import { clipFacts } from './clipFacts'
import { isReactionToken } from './signals'
import { computeSignals } from './structureSignals'
import type { TasteAdjustments } from './taste'
import { wordsIn } from './transcript'

export const VIRALITY = {
  weights: { evidence: 0.55, payoff: 0.15, hook: 0.1, content: 0.1, coldOpen: 0.06, loop: 0.04 },
  /** Inside the evidence part: chat spike z, distinct chatters, distinct reactors. */
  chatParts: { z: 0.5, chatters: 0.2, reactors: 0.3 },
  /** The z-score / chatter counts that count as full marks. */
  chatZScale: 5,
  fullChatters: 8,
  fullReactors: 5,
  /** Loudness z (same scale as `moments.ts`, where 3 is the detection bar) at which the loudness factor reaches 0.63. */
  loudZScale: 4,
  /** A transcript-only moment has no chat or loudness; its finder strength counts at this fraction. */
  transcriptEvidence: 0.6,
  /** Chat is read this many seconds either side of the peak. */
  chatAroundPeakSec: 10,
  /** Share of the score that comes from the model's rating when there is one. */
  llmWeight: 0.2,
  /** How far the taste model's source weight (0.6-1.5) is allowed to move the evidence part. */
  tasteInfluence: 0.6,
  payoff: { idealSetupSec: [3, 15] as const, setupZeroAt: 30, peakLateFrom: 0.85, quotable: 0.3, noSpeechQuotable: 0.6, noQuoteQuotable: 0.3 },
  hookByGrade: { soft: 1, hard: 0.75, late: 0.25, unknown: 0.4 },
  /** Used for a hook or content result the clip does not have yet. */
  neutral: 0.5,
  /** Pre-selection: at least this score, and (with enough clips) clear of the job's own middle. */
  topPick: { floor: 0.55, minClipsForRelative: 4, spreads: 0.5, minSpread: 0.05 }
} as const

export interface ViralityFactors {
  /** Chat block, 0..1: spike, distinct chatters, distinct reactors. */
  chat: number
  loud: number
  /** Chat and loudness combined (before taste). */
  evidence: number
  payoff: number
  hook: number
  content: number
  coldOpen: number
  loop: number
  /** The model's rating as 0..1, or null. */
  llm: number | null
  /** The taste multiplier applied to the evidence, 1 when there is none. */
  taste: number
}

export interface ClipScore {
  score: number
  factors: ViralityFactors
}

function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n))
}

/** 0..1 that rises quickly then flattens, 1 - e^(-x/scale). */
function saturate(x: number, scale: number): number {
  return 1 - Math.exp(-Math.max(0, x) / scale)
}

function chatFactor(clip: Clip, peakSec: number): number {
  const c = VIRALITY
  const from = clip.start + peakSec - c.chatAroundPeakSec
  const to = clip.start + peakSec + c.chatAroundPeakSec
  const chatters = new Set<string>()
  const reactors = new Set<string>()
  for (const m of clip.chatMessages ?? []) {
    if (m.t < from || m.t > to) continue
    const user = m.user.toLowerCase()
    chatters.add(user)
    if (isReactionToken(m.text)) reactors.add(user)
  }
  const z = saturate(clip.signals?.chatZ ?? 0, c.chatZScale)
  const p = c.chatParts
  return clamp01(p.z * z + p.chatters * clamp01(chatters.size / c.fullChatters) + p.reactors * clamp01(reactors.size / c.fullReactors))
}

/** A setup long enough to understand and short enough to keep watching, ending on the reaction rather than after it. */
function payoffFactor(clip: Clip, setupSec: number, peakRatio: number, hasQuote: boolean): number {
  const p = VIRALITY.payoff
  const [lo, hi] = p.idealSetupSec
  const setup = setupSec < lo ? setupSec / lo : setupSec <= hi ? 1 : clamp01(1 - (setupSec - hi) / (p.setupZeroAt - hi))
  const peak = peakRatio <= p.peakLateFrom ? 1 : clamp01((1 - peakRatio) / (1 - p.peakLateFrom))
  // A silent funny reaction has nothing to quote and is not marked down for it.
  const speech = wordsIn(clip.words, clip.start, clip.end).length >= 3
  const quote = hasQuote ? 1 : speech ? p.noQuoteQuotable : p.noSpeechQuotable
  return clamp01((1 - p.quotable) * (0.55 * setup + 0.45 * peak) + p.quotable * quote)
}

function hookFactor(clip: Clip): number {
  const hook = clip.editPlan?.hook
  if (!hook) return VIRALITY.neutral
  const base = VIRALITY.hookByGrade[hook.grade]
  return hook.pass ? base : Math.min(base, VIRALITY.hookByGrade.late)
}

function contentFactor(clip: Clip): number {
  const content = clip.editPlan?.content
  if (!content) return VIRALITY.neutral
  return content.pass ? 0.6 + 0.4 * clamp01((content.coverage - 0.4) / 0.4) : 0.2
}

/** Taste model's multiplier on the evidence part for a clip's source (1 without history). */
function tasteMultiplier(clip: Clip, taste: TasteAdjustments | undefined): number {
  const source = clip.signals?.source
  if (!taste || !source) return 1
  const w = source === 'chat' ? taste.chatWeight : source === 'audio' ? taste.audioWeight : taste.transcriptWeight
  return 1 + VIRALITY.tasteInfluence * (w - 1)
}

/** The score of one clip and how it came about. `taste` is the local model learnt from his accepts and rejects, when there is one. */
export function scoreClip(clip: Clip, taste?: TasteAdjustments): ClipScore {
  const c = VIRALITY
  const signals = computeSignals(clipFacts(clip))
  const chat = chatFactor(clip, signals.setupLength)
  const loud = saturate(clip.signals?.audioZ ?? 0, c.loudZScale)
  const transcript = clip.signals?.source === 'transcript' ? clamp01(clip.signals.score) * c.transcriptEvidence : 0
  // Independent evidence: each one alone can carry the clip and agreement lifts it.
  const evidence = 1 - (1 - chat) * (1 - loud) * (1 - transcript)
  const tasteMult = tasteMultiplier(clip, taste)
  const payoff = payoffFactor(clip, signals.setupLength, signals.peakRatio, signals.quotableSpans.length > 0)
  const hook = hookFactor(clip)
  const content = contentFactor(clip)
  const cold = clip.editPlan?.coldOpen
  const coldOpen = cold?.qualifies ? clamp01(cold.confidence) : 0
  const loop = clip.editPlan?.loop.eligible ? 1 : 0

  const w = c.weights
  const local = clamp01(w.evidence * clamp01(evidence * tasteMult) + w.payoff * payoff + w.hook * hook + w.content * content + w.coldOpen * coldOpen + w.loop * loop)
  const rating = clip.signals?.rating
  const llm = rating === null || rating === undefined ? null : clamp01((rating - 1) / 9)
  const score = llm === null ? local : (1 - c.llmWeight) * local + c.llmWeight * llm
  return { score: clamp01(score), factors: { chat, loud, evidence, payoff, hook, content, coldOpen, loop, llm, taste: tasteMult } }
}

function median(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const mid = sorted.length >> 1
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/**
 * Which of a job's scores are clearly strong: at or above an absolute floor
 * and, with enough clips to have a distribution, above the job's own middle by
 * half a spread (robust, like the finder's own bars). The count follows the
 * quality and is never fixed; the best clip is always eligible when it clears
 * the floor, and a job of weak clips pre-selects none.
 */
export function pickTopScores(scores: number[]): boolean[] {
  const t = VIRALITY.topPick
  if (scores.length === 0) return []
  let bar: number = t.floor
  if (scores.length >= t.minClipsForRelative) {
    const sorted = [...scores].sort((a, b) => a - b)
    const med = median(sorted)
    const mad = median(sorted.map((s) => Math.abs(s - med)))
    const relative = med + t.spreads * Math.max(1.4826 * mad, t.minSpread)
    bar = Math.max(t.floor, Math.min(relative, sorted[sorted.length - 1]!))
  }
  return scores.map((s) => s >= bar - 1e-9)
}

export interface RankedClips {
  clips: Clip[]
  /** One compact line per clip for the local log. */
  lines: string[]
}

function fmt(n: number | null): string {
  return n === null ? '-' : n.toFixed(2)
}

/** `virality clip=ab12cd34 score=0.71 pick=yes chat=... ` */
export function formatViralityLine(clipTag: string, s: ClipScore, topPick: boolean): string {
  const f = s.factors
  const parts = [`chat=${fmt(f.chat)}`, `loud=${fmt(f.loud)}`, `evid=${fmt(f.evidence)}`, `payoff=${fmt(f.payoff)}`, `hook=${fmt(f.hook)}`, `content=${fmt(f.content)}`, `cold=${fmt(f.coldOpen)}`, `loop=${fmt(f.loop)}`, `llm=${fmt(f.llm)}`, `taste=${fmt(f.taste)}`]
  return `virality clip=${clipTag} score=${fmt(s.score)} pick=${topPick ? 'yes' : 'no'} ${parts.join(' ')}`
}

/**
 * Scores a fresh job's clips, orders them best first (`rank` 1 is the best;
 * ties keep their order), and accepts the clearly strong ones. Clips already
 * accepted or rejected keep their status.
 */
export function rankClips(clips: Clip[], taste?: TasteAdjustments): RankedClips {
  const scored = clips.map((clip, i) => ({ clip, i, s: scoreClip(clip, taste) }))
  const picks = pickTopScores(scored.map((x) => x.s.score))
  const withPick = scored.map((x, k) => ({ ...x, top: picks[k]! }))
  withPick.sort((a, b) => b.s.score - a.s.score || a.i - b.i)
  const lines = withPick.map((x) => formatViralityLine(x.clip.id.slice(0, 8), x.s, x.top))
  const out = withPick.map((x, k) => {
    const virality: ClipVirality = { score: Math.round(x.s.score * 1000) / 1000, topPick: x.top }
    return { ...x.clip, rank: k + 1, virality, status: x.top && x.clip.status === 'pending' ? ('accepted' as const) : x.clip.status }
  })
  return { clips: out, lines }
}

/** A clip saved before the score existed: scored, not pre-selected (its status is whatever he left it as). */
export function withLegacyScore(clip: Clip, taste?: TasteAdjustments): Clip {
  return { ...clip, virality: { score: Math.round(scoreClip(clip, taste).score * 1000) / 1000, topPick: false } }
}

/** Best first by score, `rank` renumbered (ties keep their order). Clips without a score sort last. */
export function orderBestFirst(clips: Clip[]): Clip[] {
  return clips
    .map((clip, i) => ({ clip, i }))
    .sort((a, b) => (b.clip.virality?.score ?? -1) - (a.clip.virality?.score ?? -1) || a.i - b.i)
    .map((x, k) => ({ ...x.clip, rank: k + 1 }))
}
