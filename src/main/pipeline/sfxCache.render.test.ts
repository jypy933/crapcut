// Renders the cache with real FFmpeg into a temp directory (never the real
// %LOCALAPPDATA%\CrapCut) and checks it renders once and is reused after
// that. Skips cleanly when FFmpeg is not on PATH.

import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SFX_KINDS } from '../core/sfx'
import { ensureSfxCache } from './sfxCache'

function findOnPath(name: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' })
    const first = out.split(/\r?\n/).find((l) => l.trim())
    return first?.trim() || null
  } catch {
    return null
  }
}

const ffmpeg = findOnPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')

describe.skipIf(!ffmpeg)('ensureSfxCache (real FFmpeg)', () => {
  it('renders every kind once into the cache directory and reuses them after that', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'crapcut-sfx-cache-'))
    try {
      const files = await ensureSfxCache(ffmpeg!, dir)
      for (const kind of SFX_KINDS) {
        expect(files[kind]).toBeDefined()
        expect(existsSync(files[kind]!)).toBe(true)
      }

      const mtimesBefore = SFX_KINDS.map((k) => statSync(files[k]!).mtimeMs)
      const again = await ensureSfxCache(ffmpeg!, dir)
      const mtimesAfter = SFX_KINDS.map((k) => statSync(again[k]!).mtimeMs)
      expect(mtimesAfter).toEqual(mtimesBefore) // untouched, not re-rendered
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 30_000)
})
