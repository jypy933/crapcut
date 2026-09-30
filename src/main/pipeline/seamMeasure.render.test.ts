// Runs the two edit-time measurements against tiny FFmpeg-generated clips:
// the loudness envelope (a tone that stops) and the loop seam (identical
// first and last frame, or a red clip that ends blue). Skips cleanly when
// FFmpeg is not on PATH.

import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { runTool } from '../tools/process'
import { measureEnvelope, measureSeam } from './seamMeasure'

function findOnPath(name: string): string | null {
  try {
    const out = execFileSync(process.platform === 'win32' ? 'where' : 'which', [name], { encoding: 'utf8' })
    return out.split(/\r?\n/).find((l) => l.trim())?.trim() || null
  } catch {
    return null
  }
}

const ffmpeg = findOnPath(process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg')
const signal = new AbortController().signal

describe.skipIf(!ffmpeg)('seamMeasure (FFmpeg)', () => {
  let dir: string
  const file = (name: string): string => join(dir, name)

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'crapcut-seam-'))
    const base = ['-hide_banner', '-nostdin', '-y']
    // 4 s: a tone for 2 s then silence; the picture is a static red frame.
    await runTool(ffmpeg!, [...base, '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=10:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-af', "volume='if(lt(t,2),1,0)':eval=frame", '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file('tone-stop.mp4')])
    // 4 s of constant tone; red for two seconds, then blue.
    await runTool(ffmpeg!, [
      ...base,
      '-f', 'lavfi', '-i', 'color=c=red:s=320x180:r=10:d=2',
      '-f', 'lavfi', '-i', 'color=c=blue:s=320x180:r=10:d=2',
      '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4',
      '-filter_complex', '[0:v][1:v]concat=n=2:v=1:a=0[v]',
      '-map', '[v]', '-map', '2:a', '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file('red-blue.mp4')
    ])
    await runTool(ffmpeg!, [...base, '-f', 'lavfi', '-i', 'color=c=green:s=320x180:r=10:d=4', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=4', '-shortest', '-pix_fmt', 'yuv420p', '-c:a', 'aac', file('steady.mp4')])
  }, 60_000)

  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  it('measures a 0.1 s envelope in VOD seconds: loud while the tone plays, silent after', async () => {
    const env = await measureEnvelope(ffmpeg!, file('tone-stop.mp4'), 4, 1000, signal)
    expect(env).not.toBeNull()
    expect(env!.startSec).toBe(1000)
    expect(env!.stepSec).toBe(0.1)
    expect(env!.db.length).toBeGreaterThanOrEqual(38)
    expect(env!.db[10]!).toBeGreaterThan(-40)
    expect(env!.db[env!.db.length - 3]!).toBeLessThan(-60)
  }, 30_000)

  it('scores identical first and last frames as a good seam, with no loudness step', async () => {
    const env = await measureEnvelope(ffmpeg!, file('steady.mp4'), 4, 500, signal)
    const seam = await measureSeam(ffmpeg!, file('steady.mp4'), { firstSec: 0.2, lastSec: 3.5, endSec: 3.6 }, { seekSec: 0, windowStartVod: 500 }, null, env, signal)
    expect(seam).not.toBeNull()
    expect(seam!.frameSimilarity).toBeGreaterThan(0.95)
    expect(seam!.loudnessDiffLu).toBeLessThan(1)
  }, 30_000)

  it('scores a red first frame against a blue last frame as a poor seam', async () => {
    const env = await measureEnvelope(ffmpeg!, file('red-blue.mp4'), 4, 500, signal)
    const seam = await measureSeam(ffmpeg!, file('red-blue.mp4'), { firstSec: 0.2, lastSec: 3.5, endSec: 3.6 }, { seekSec: 0, windowStartVod: 500 }, null, env, signal)
    expect(seam!.frameSimilarity).toBeLessThan(0.55)
  }, 30_000)

  it('also compares a facecam area when the layout has one', async () => {
    const env = await measureEnvelope(ffmpeg!, file('red-blue.mp4'), 4, 500, signal)
    const seam = await measureSeam(ffmpeg!, file('red-blue.mp4'), { firstSec: 0.2, lastSec: 3.5, endSec: 3.6 }, { seekSec: 0, windowStartVod: 500 }, { x: 0.6, y: 0.6, w: 0.3, h: 0.3 }, env, signal)
    expect(seam!.frameSimilarity).toBeLessThan(0.55)
  }, 30_000)

  it('has no seam to judge without a loudness envelope', async () => {
    expect(await measureSeam(ffmpeg!, file('steady.mp4'), { firstSec: 0.2, lastSec: 3.5, endSec: 3.6 }, { seekSec: 0, windowStartVod: 500 }, null, null, signal)).toBeNull()
  })
})
