// Runs the auto edit's rule engine (`core/editPlan.ts`) where the outside
// world is involved: at moments time (loudness log, the local language model
// for the cold-open check; clips can be grown from their download padding or
// dropped) and at edit time (a fine loudness envelope and the loop seam
// measured from the downloaded clip with FFmpeg). Every check's result goes to
// the local log as one compact line and the plan is stored on the clip for the
// variants and per-platform export to read; none of it reaches the UI.

import type { ClipEditPlan } from '@shared/editPlan'
import type { Clip, Range, Rect } from '@shared/types'
import { clipFacts, decideStructureHeuristically } from '../core/clipFacts'
import { confirmColdOpen } from '../core/coldOpenLlm'
import { formatCheckLine, type Envelope } from '../core/editRules'
import { planAutoEdit, type PlanResult } from '../core/editPlan'
import { isLoudPeak } from '../core/moments'
import { runPool } from '../core/pool'
import type { CompleteFn } from '../core/structureLlm'
import type { SfxKind } from '../core/viralEdit'
import { clipRelativeWords } from '../core/viralEdit'
import type { Store } from '../store'
import { isCancelled } from '../util/errors'
import type { Logger } from '../util/log'
import { logger } from '../util/log'
import { measureEnvelope, measureSeam } from './seamMeasure'

const defaultLog = logger('editRules')

/** The clip's first eight characters, the way every other log line names it. */
const tag = (clip: Clip): string => clip.id.slice(0, 8)

function logChecks(log: Logger, clip: Clip, result: PlanResult): void {
  for (const check of result.checks) log.info(formatCheckLine(tag(clip), check))
}

/** Saves the plan on the stored clip when it changed, leaving whatever else was edited meanwhile alone. */
function storePlan(store: Store, clipId: string, plan: ClipEditPlan): void {
  const fresh = store.clip(clipId)
  if (!fresh || JSON.stringify(fresh.editPlan) === JSON.stringify(plan)) return
  store.saveClip({ ...fresh, editPlan: plan })
}

export interface ResolveArgs {
  ffmpeg: string
  /** The clip's downloaded video. */
  input: string
  clip: Clip
  /** The cut, VOD seconds, already inside `clip.source`. */
  window: Range
  cam: Rect | null
  sfx?: Partial<Record<SfxKind, string>>
  signal: AbortSignal
  log?: Logger
}

/**
 * The plan for a downloaded clip at edit time, with the real loudness of the
 * clip and, when a loop is possible, the frame and loudness match across its
 * seam. A measurement that fails only means less is known (no fine envelope:
 * the pauses use the coarse rules; no seam: no loop is offered).
 */
export async function resolveAutoEdit(store: Store, args: ResolveArgs): Promise<PlanResult> {
  const { ffmpeg, input, clip, window, signal } = args
  const log = args.log ?? defaultLog
  const source = clip.source!
  let envelope: Envelope | null = null
  try {
    envelope = await measureEnvelope(ffmpeg, input, source.end - source.start, source.start, signal)
  } catch (err) {
    if (isCancelled(err)) throw err
    log.warn(`clip ${tag(clip)}: could not measure loudness; using the coarse rules`, err)
  }

  const decision = clip.structureDecision ?? decideStructureHeuristically(clip)
  const base = { facts: { ...clipFacts(clip), window }, decision, bounds: source, options: { sfx: args.sfx }, envelope, previous: clip.editPlan, loudPeak: isLoudPeak(clip.signals?.audioZ) }
  let result = planAutoEdit(base)

  if (result.seamProbe) {
    const probe = result.seamProbe
    const prev = clip.editPlan?.loop
    // The same loop end as last time has the same seam: no need to grab the frames again.
    let seam =
      prev && prev.seamScore !== null && prev.loudnessDiffLu !== null && prev.endSec !== null && Math.abs(prev.endSec - probe.endSec) < 0.01
        ? { frameSimilarity: prev.seamScore, loudnessDiffLu: prev.loudnessDiffLu }
        : null
    if (!seam) {
      try {
        seam = await measureSeam(ffmpeg, input, probe, { seekSec: probe.window.start - source.start, windowStartVod: probe.window.start }, args.cam, envelope, signal)
      } catch (err) {
        if (isCancelled(err)) throw err
        log.warn(`clip ${tag(clip)}: could not measure the loop seam`, err)
      }
    }
    if (seam) result = planAutoEdit({ ...base, seam })
  }

  logChecks(log, clip, result)
  storePlan(store, clip.id, result.plan)
  return result
}

export interface MomentPlanArgs {
  /** The whole VOD's per-second loudness (`loudness.txt`). */
  loudness: Float64Array
  durationSec: number
  /** Seconds of video downloaded around each cut: how far a cut may grow. */
  padSec: number
  /** Asks the local language model; null when there is none (the stricter cold-open gate applies). */
  complete: CompleteFn | null
  concurrency: number
  /** The clips kept at least, so the content floor alone cannot empty a small job. */
  minKeep: number
  signal: AbortSignal
  log: Logger
}

/**
 * The rule engine over a job's freshly chosen clips, before they are saved:
 * cuts under the length floor are grown from their padding (after skipping
 * the edit, see `planAutoEdit`), clips that still fall short are dropped, and
 * clips failing the content floor are dropped too unless that would leave
 * fewer than `minKeep`. Returns the clips in their original order with their
 * plan stored, re-ranked.
 */
export async function planMomentEdits(clips: Clip[], args: MomentPlanArgs): Promise<{ clips: Clip[]; dropped: number }> {
  const { loudness, durationSec, padSec, complete, log } = args
  const inputs = (clip: Clip) => ({
    facts: clipFacts(clip, loudness, 0),
    decision: clip.structureDecision ?? decideStructureHeuristically(clip),
    bounds: { start: Math.max(0, clip.start - padSec), end: Math.min(durationSec, clip.end + padSec) },
    loudPeak: isLoudPeak(clip.signals?.audioZ)
  })

  const pool = await runPool(
    clips,
    async (clip) => {
      // The model is only asked about a cold open the deterministic gate would let through with its help.
      const lenient = complete ? planAutoEdit({ ...inputs(clip), llm: 'confirmed' }) : null
      const preview = lenient?.plan.coldOpen.qualifies ? lenient.plan.coldOpen.segments[0] : undefined
      let llm: ClipEditPlan['coldOpen']['llm'] = 'unavailable'
      if (complete && lenient && preview) llm = await confirmColdOpen(clipRelativeWords({ ...inputs(clip).facts, window: lenient.window }), preview, complete)
      return planAutoEdit({ ...inputs(clip), llm })
    },
    { concurrency: Math.max(1, args.concurrency), maxFailures: 1, signal: args.signal, onFailure: (err) => log.warn('rule engine failed for a clip; keeping it as is', err) }
  )

  const planned = clips.map((clip, i) => {
    const r = pool.results[i]
    if (!r) return { clip, drop: false, contentOk: true }
    logChecks(log, clip, r)
    return { clip: { ...clip, start: r.window.start, end: r.window.end, editPlan: r.plan }, drop: r.drop, contentOk: r.contentOk }
  })

  const keep = planned.filter((p) => !p.drop && p.contentOk)
  // A failed content floor only costs a clip while enough others remain.
  for (const p of planned) {
    if (keep.length >= Math.min(args.minKeep, planned.length)) break
    if (!p.drop && !p.contentOk) keep.push(p)
  }
  const kept = keep.length > 0 ? planned.filter((p) => keep.includes(p)) : planned
  return { clips: kept.map((p, i) => ({ ...p.clip, rank: i + 1 })), dropped: planned.length - kept.length }
}
