// Renders each real sound effect with FFmpeg and checks it with ffprobe /
// volumedetect: short, not silent, not clipping. A listen-check is
// impossible from here, so this is the whole verification. Skips cleanly
// when FFmpeg is not on PATH.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { probeMedia } from '../pipeline/media'
import { runTool } from '../tools/process'
import { buildSfxArgs, sfxDuration, SFX_KINDS } from './sfx'

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
const ffprobe = findOnPath(process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe')

/** Reads volumedetect's "mean_volume: X dB" / "max_volume: X dB" lines from stderr. */
function parseVolumeDetect(stderr: string): { mean: number; max: number } {
  const mean = /mean_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(stderr)
  const max = /max_volume:\s*(-?[\d.]+|-inf)\s*dB/.exec(stderr)
  const toDb = (m: RegExpExecArray | null): number => (m ? (m[1] === '-inf' ? -Infinity : Number(m[1])) : -Infinity)
  return { mean: toDb(mean), max: toDb(max) }
}

describe.skipIf(!ffmpeg || !ffprobe)('sound effects (real FFmpeg)', () => {
  for (const kind of SFX_KINDS) {
    it(`renders ${kind} as a short, non-silent, non-clipping mono file`, async () => {
      const dir = mkdtempSync(join(tmpdir(), `crapcut-sfx-${kind}-`))
      try {
        const file = join(dir, `${kind}.wav`)
        await runTool(ffmpeg!, buildSfxArgs(kind, file))

        const media = await probeMedia(ffprobe!, file)
        expect(media.hasAudio).toBe(true)
        expect(media.duration).toBeGreaterThan(0)
        expect(media.duration).toBeLessThanOrEqual(sfxDuration(kind) + 0.05)
        expect(media.duration).toBeLessThan(1)

        const { stderr } = await runTool(ffmpeg!, ['-hide_banner', '-nostdin', '-i', file, '-af', 'volumedetect', '-f', 'null', '-'])
        const { mean, max } = parseVolumeDetect(stderr)
        expect(mean).toBeGreaterThan(-60) // not silent
        expect(max).toBeLessThan(0) // not clipping (headroom below 0 dBFS)
        expect(max).toBeGreaterThan(-30) // still audible, not accidentally near-silent
      } finally {
        rmSync(dir, { recursive: true, force: true })
      }
    }, 30_000)
  }
})
