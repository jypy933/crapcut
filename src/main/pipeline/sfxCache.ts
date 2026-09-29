// Renders the viral-edit house look's small set of sound effects once, into
// CrapCut's tools cache, and reuses them after that -- the same idea as
// `tools/registry.ts`'s installed-marker check, but for something generated
// locally with FFmpeg instead of downloaded.

import { existsSync, mkdirSync, renameSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { buildSfxArgs, SFX_KINDS, type SfxKind } from '../core/sfx'
import { runTool } from '../tools/process'

/** Absolute paths of the rendered SFX files, keyed by kind -- shape `ViralEditOptions.sfx` expects. */
export type SfxFiles = Partial<Record<SfxKind, string>>

/**
 * Renders any of `SFX_KINDS` not already cached under `cacheDir` (normally
 * `%LOCALAPPDATA%\CrapCut\tools\sfx`; tests always pass a temp directory,
 * never that real folder). Idempotent and cheap to call before every export
 * that needs the house look: an existing file is reused untouched, and a
 * fresh one is rendered to a temporary name first and renamed into place, so
 * a crash mid-render never leaves a half-written file mistaken for a good one.
 */
export async function ensureSfxCache(ffmpeg: string, cacheDir: string): Promise<SfxFiles> {
  mkdirSync(cacheDir, { recursive: true })
  const files: SfxFiles = {}
  for (const kind of SFX_KINDS) {
    const file = join(cacheDir, `${kind}.wav`)
    if (!existsSync(file)) {
      // ".wav" stays the last extension so FFmpeg's muxer guess (from the file name) still works.
      const tmp = join(cacheDir, `${kind}.tmp.wav`)
      rmSync(tmp, { force: true })
      await runTool(ffmpeg, buildSfxArgs(kind, tmp))
      renameSync(tmp, file)
    }
    files[kind] = file
  }
  return files
}
