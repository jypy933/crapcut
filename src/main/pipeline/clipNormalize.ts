// Fills in clip fields added after a clip was first saved, so a database from
// before this field existed keeps working instead of crashing Review, export
// or the best-of build. Chat overlay (added after v1) was the first case:
// `chatMessages`/`chatOverlay` are missing from an old row's JSON, even
// though the `Clip` type says they are always there. The automatic viral
// edit is the second: `autoEdit`/`structureDecision` are missing the same
// way, and a clip that already has both fields but no decision yet (moments
// only computes it going forward) gets one computed here too, heuristically
// -- the language model only ever runs once, in the moments step itself.
//
// The fix-up itself is pure (`normalizeClip`); reading `chat.txt` and saving
// the result back is the only part that needs `Store`/`AppPaths`, done here
// so every place that reads clips (Review's list, an export, a best-of
// build) can just call one of these instead of `store.clip`/`store.clips`.

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { chatIn } from '@shared/chatOverlay'
import type { ChatMessage, Clip } from '@shared/types'
import { parseChatLog } from '../core/chat'
import { decideStructureHeuristically } from '../core/clipFacts'
import { jobDir, type AppPaths } from '../paths'
import type { Store } from '../store'
import { CLIP_PAD_SEC } from './steps'

/** True once a clip is missing a field added after it was first saved. */
export function needsNormalizing(clip: Clip): boolean {
  return !Array.isArray(clip.chatMessages) || typeof clip.chatOverlay !== 'boolean' || typeof clip.autoEdit !== 'boolean' || !clip.structureDecision
}

/**
 * Pure: fills in the chat-overlay and auto-edit fields on a clip.
 * `chatMessages` is only used when the clip does not already have its own
 * (an old row); `chatIn` (the clip's padded range) has normally already been
 * applied by the caller. The structure decision is computed from the clip's
 * own (already-filled-in) words and chat, no language model and no loudness
 * -- cheap enough to do on every normalize, and only actually runs once per
 * clip since the result is saved back.
 */
export function normalizeClip(clip: Clip, chatMessages: ChatMessage[]): Clip {
  const withChat: Clip = {
    ...clip,
    chatMessages: Array.isArray(clip.chatMessages) ? clip.chatMessages : chatMessages,
    chatOverlay: typeof clip.chatOverlay === 'boolean' ? clip.chatOverlay : false
  }
  return {
    ...withChat,
    autoEdit: typeof withChat.autoEdit === 'boolean' ? withChat.autoEdit : true,
    structureDecision: withChat.structureDecision ?? decideStructureHeuristically(withChat)
  }
}

/** The job's whole chat log, windowed later per clip. `[]` when chat.txt is missing. */
async function loadChatMessages(paths: AppPaths, jobId: string): Promise<ChatMessage[]> {
  try {
    const text = await readFile(join(jobDir(paths, jobId), 'chat.txt'), 'utf8')
    return parseChatLog(text)
  } catch {
    return []
  }
}

/** Normalizes one clip if needed, saving it once so this does not repeat on the next read. */
export async function ensureClipNormalized(store: Store, paths: AppPaths, clip: Clip): Promise<Clip> {
  if (!needsNormalizing(clip)) return clip
  const messages = await loadChatMessages(paths, clip.jobId)
  const normalized = normalizeClip(clip, chatIn(messages, clip.start - CLIP_PAD_SEC, clip.end + CLIP_PAD_SEC))
  store.saveClip(normalized)
  return normalized
}

/** Same, for a whole job's clips; reads chat.txt at most once even if several need it. */
export async function ensureClipsNormalized(store: Store, paths: AppPaths, clips: Clip[]): Promise<Clip[]> {
  if (clips.length === 0 || !clips.some(needsNormalizing)) return clips
  const messages = await loadChatMessages(paths, clips[0]!.jobId)
  return clips.map((clip) => {
    if (!needsNormalizing(clip)) return clip
    const normalized = normalizeClip(clip, chatIn(messages, clip.start - CLIP_PAD_SEC, clip.end + CLIP_PAD_SEC))
    store.saveClip(normalized)
    return normalized
  })
}
