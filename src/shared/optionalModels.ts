// Groups the optional AI tool/model artifacts (see main/tools/manifest.ts)
// into the two plain-language parts a settings screen offers: the language
// model behind smarter clip picks and titles, and voice separation. Pure, so
// both the main process and the renderer can use it without pulling in
// Electron.

import { canRunBigLlm } from './hardware'
import type { ComponentState, HardwareProfile, SetupComponent } from './types'

export type OptionalModelId = 'llm' | 'voiceSeparation'

/** Artifact ids used by an optional part. A subset of main/tools/manifest.ts's ToolId. */
export type OptionalArtifactId = 'llama' | 'llama-cuda' | 'llama-cuda-runtime' | 'model-llm-9b' | 'model-llm-3b' | 'separator' | 'model-demucs'

export interface OptionalModel {
  id: OptionalModelId
  label: string
  description: string
  /** Which model variant this PC would download, e.g. "Ministral 3 8B" (only set for the language model). */
  variant: string | null
  sizeBytes: number
  state: ComponentState
  progress: number
}

interface Part {
  id: OptionalModelId
  label: string
  description: string
  artifactIds: (hw: HardwareProfile) => OptionalArtifactId[]
}

const PARTS: readonly Part[] = [
  {
    id: 'llm',
    label: 'Smart picks and titles',
    description: 'A small local language model that sharpens which moments become clips and writes their titles. Without it, CrapCut still finds clips from chat and audio alone.',
    // On NVIDIA the CUDA build comes along; the Vulkan one stays as the fallback.
    artifactIds: (hw) => ['llama', ...(hw.llmCuda ? (['llama-cuda', 'llama-cuda-runtime'] as const) : []), canRunBigLlm(hw) ? 'model-llm-9b' : 'model-llm-3b']
  },
  {
    id: 'voiceSeparation',
    label: 'Voice separation',
    description: "Splits the streamer's voice from game sound, so an exported clip can quiet the game or add music underneath.",
    artifactIds: () => ['separator', 'model-demucs']
  }
]

export function optionalModelArtifactIds(id: OptionalModelId, hw: HardwareProfile): OptionalArtifactId[] {
  return PARTS.find((p) => p.id === id)?.artifactIds(hw) ?? []
}

function combineState(states: ComponentState[]): ComponentState {
  if (states.length > 0 && states.every((s) => s === 'ready')) return 'ready'
  if (states.some((s) => s === 'downloading')) return 'downloading'
  if (states.some((s) => s === 'installing')) return 'installing'
  if (states.some((s) => s === 'verifying')) return 'verifying'
  if (states.some((s) => s === 'failed')) return 'failed'
  return 'missing'
}

/** Pulls "Ministral 3 8B" out of a manifest label like "Language model (Ministral 3 8B)". */
function variantOf(label: string): string {
  const m = /\(([^)]+)\)/.exec(label)
  return m?.[1] ?? label
}

/** Builds the settings view of the optional AI parts from the setup manager's component list. */
export function buildOptionalModels(hw: HardwareProfile, components: readonly SetupComponent[]): OptionalModel[] {
  const byId = new Map(components.map((c) => [c.id, c]))
  return PARTS.map((part) => {
    const ids = part.artifactIds(hw)
    const comps = ids.map((id) => byId.get(id)).filter((c): c is SetupComponent => !!c)
    const sizeBytes = comps.reduce((s, c) => s + c.sizeBytes, 0)
    const progress = sizeBytes ? comps.reduce((s, c) => s + c.sizeBytes * (c.state === 'ready' ? 1 : c.progress), 0) / sizeBytes : 0
    const llmModel = comps.find((c) => c.id === 'model-llm-9b' || c.id === 'model-llm-3b')
    return {
      id: part.id,
      label: part.label,
      description: part.description,
      variant: llmModel ? variantOf(llmModel.label) : null,
      sizeBytes,
      progress,
      state: combineState(comps.map((c) => c.state))
    }
  })
}
