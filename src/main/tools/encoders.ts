// Picks the video encoder by actually trying each hardware encoder with a tiny
// test encode; libx264 always works as the fallback.

import type { GpuVendor } from '@shared/types'
import type { EncoderId } from '../core/render'
import { logger } from '../util/log'
import { runTool } from './process'

const log = logger('encoders')

/** Which hardware encoders to try, best first, for a GPU vendor. */
export function encoderCandidates(vendor: GpuVendor | null): EncoderId[] {
  switch (vendor) {
    case 'nvidia':
      return ['h264_nvenc', 'h264_qsv']
    case 'amd':
      return ['h264_amf', 'h264_qsv']
    case 'intel':
      return ['h264_qsv']
    default:
      return ['h264_nvenc', 'h264_amf', 'h264_qsv']
  }
}

/** A one-second 1080p test encode to null; fails fast if the encoder is unusable. */
export function probeArgs(encoder: EncoderId): string[] {
  return [
    '-hide_banner',
    '-nostdin',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=1920x1080:rate=30:duration=1',
    '-pix_fmt',
    'yuv420p',
    '-c:v',
    encoder,
    '-f',
    'null',
    '-'
  ]
}

export async function probeEncoder(ffmpeg: string, encoder: EncoderId): Promise<boolean> {
  try {
    await runTool(ffmpeg, probeArgs(encoder), { timeoutMs: 20_000 })
    return true
  } catch (err) {
    log.info(`${encoder} not usable`, err instanceof Error ? err.message.slice(0, 300) : err)
    return false
  }
}

/** Best working encoder for this PC. */
export async function chooseEncoder(ffmpeg: string, vendor: GpuVendor | null): Promise<EncoderId> {
  for (const e of encoderCandidates(vendor)) {
    if (await probeEncoder(ffmpeg, e)) {
      log.info(`using ${e}`)
      return e
    }
  }
  log.info('using libx264')
  return 'libx264'
}
