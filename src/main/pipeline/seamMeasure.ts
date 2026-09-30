// The two measurements the rule engine needs from a downloaded clip at edit
// time, both with FFmpeg run through argument arrays (never a shell): a fine
// loudness envelope (for pauses, quiet after the last word and the loudness
// match across a loop seam) and the first and last frame of a candidate loop.
// The scoring itself is pure (`core/editRules.ts`, `core/loopSeam.ts`).

import type { Rect, Word } from '@shared/types'
import { pcm16ToFloat } from '../core/align'
import { envelopeFromSamples, shiftEnvelope, type Envelope } from '../core/editRules'
import { buildFrameGrabArgs, frameSimilarity, SEAM_CAM_FRAME, SEAM_FRAME, speechLevelDiff, type SeamMeasure } from '../core/loopSeam'
import { extractPcm, runToolBinary } from './media'

/** One loudness value per this many seconds. */
export const ENVELOPE_STEP_SEC = 0.1
const ENVELOPE_RATE = 8000

/** The loudness envelope of a whole downloaded clip file, in VOD seconds (`fileStartVodSec` is where the file starts); null with no audio. */
export async function measureEnvelope(ffmpeg: string, input: string, fileDurationSec: number, fileStartVodSec: number, signal: AbortSignal): Promise<Envelope | null> {
  const pcm = await extractPcm(ffmpeg, input, 0, fileDurationSec, signal)
  if (pcm.length < ENVELOPE_RATE * ENVELOPE_STEP_SEC * 2) return null
  return envelopeFromSamples(pcm16ToFloat(pcm), ENVELOPE_RATE, ENVELOPE_STEP_SEC, fileStartVodSec)
}

async function grabFrame(ffmpeg: string, input: string, atSec: number, cam: Rect | null, signal: AbortSignal): Promise<Uint8Array | null> {
  const { stdout } = await runToolBinary(ffmpeg, buildFrameGrabArgs(input, atSec, cam), signal)
  const size = cam ? SEAM_CAM_FRAME : SEAM_FRAME
  return stdout.length === size.width * size.height ? stdout : null
}

/**
 * How alike the frame at the start of the edit and the frame at its loop end
 * are (the facecam area when the layout has one, else the whole frame), and how
 * far apart the speech level at the start and at the end is. `probe` times
 * are clip-relative; `seekSec` is where the clip starts inside `input` and
 * `windowStartVod` where it starts in the VOD (the envelope's clock). Null
 * when a frame or the loudness could not be read: the loop then just is not
 * offered.
 */
export async function measureSeam(
  ffmpeg: string,
  input: string,
  probe: { firstSec: number; lastSec: number; endSec: number; speechEndSec: number; words: Word[] },
  clip: { seekSec: number; windowStartVod: number },
  cam: Rect | null,
  env: Envelope | null,
  signal: AbortSignal
): Promise<SeamMeasure | null> {
  const local = shiftEnvelope(env, clip.windowStartVod)
  const soundStart = probe.words.find((w) => w.t1 > probe.firstSec)?.t0 ?? probe.firstSec
  const loud = local ? speechLevelDiff(local, probe.words, Math.max(probe.firstSec, soundStart), probe.speechEndSec) : null
  if (loud === null) return null
  const first = clip.seekSec + probe.firstSec
  const last = clip.seekSec + probe.lastSec
  const [firstFull, lastFull] = await Promise.all([grabFrame(ffmpeg, input, first, null, signal), grabFrame(ffmpeg, input, last, null, signal)])
  if (!firstFull || !lastFull) return null
  // What the person does across the seam matters most (the game moves on its own anyway): with a facecam
  // only the cam picture is compared, otherwise the whole frame.
  let similarity = frameSimilarity(firstFull, lastFull)
  if (cam) {
    const [firstCam, lastCam] = await Promise.all([grabFrame(ffmpeg, input, first, cam, signal), grabFrame(ffmpeg, input, last, cam, signal)])
    if (firstCam && lastCam) similarity = frameSimilarity(firstCam, lastCam)
  }
  return { frameSimilarity: similarity, loudnessDiffLu: loud }
}
