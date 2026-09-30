// What Review and the export share about per-platform export: which platforms
// exist, which version of a clip is chosen, and what the stored edit plan says
// about it. Plain data and tiny helpers only. The rules that decide what a
// platform actually gets (trim to the cap, loop, safe zone, skip) live in
// `main/core/platformPlan.ts`; this file only reads what the plan already knows.

import { PLATFORMS, type ClipEditPlan, type Platform } from './editPlan'

export const PLATFORM_LABELS: Record<Platform, string> = { tiktok: 'TikTok', shorts: 'Shorts', reels: 'Reels' }

/** All three by default: the streamer posts the same clip everywhere and untick what he does not use. */
export const DEFAULT_EXPORT_PLATFORMS: readonly Platform[] = PLATFORMS

/** A clip has at most two versions: the straight edit, and a cold open when its plan qualifies. Looping is a property of a version, not a third one. */
export const CLIP_VERSIONS = ['straight', 'coldOpen'] as const
export type ClipVersion = (typeof CLIP_VERSIONS)[number]

/** Keeps only known platforms, once each, in the fixed order. Empty or unknown input gives the default. */
export function normalizePlatforms(value: unknown): Platform[] {
  const list = Array.isArray(value) ? value : []
  const kept = PLATFORMS.filter((p) => list.includes(p))
  return kept.length > 0 ? kept : [...DEFAULT_EXPORT_PLATFORMS]
}

/** True when the clip has a cold-open version to choose (the auto edit is on and its plan qualified). */
export function hasColdOpen(clip: { autoEdit: boolean; editPlan?: ClipEditPlan }): boolean {
  return clip.autoEdit && clip.editPlan?.coldOpen.qualifies === true
}

/** The version that will be previewed and exported: the chosen one, or the straight edit when the cold open is not available (any more). */
export function chosenVersion(clip: { autoEdit: boolean; version?: ClipVersion; editPlan?: ClipEditPlan }): ClipVersion {
  return clip.version === 'coldOpen' && hasColdOpen(clip) ? 'coldOpen' : 'straight'
}

/** The platforms whose length cap the chosen version is over, according to the stored plan (an old clip has no plan: none). */
export function platformsOverCap(clip: { autoEdit: boolean; version?: ClipVersion; editPlan?: ClipEditPlan }, platforms: readonly Platform[]): Platform[] {
  const plan = clip.editPlan
  if (!plan) return []
  const fit = chosenVersion(clip) === 'coldOpen' ? plan.coldOpen.capFit : plan.capFit
  return platforms.filter((p) => fit?.[p] && !fit[p].fits)
}
