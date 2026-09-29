// Builds the FFmpeg argument list to synthesize one of the viral-edit house
// look's sound effects entirely with FFmpeg's own audio sources and filters
// (`aevalsrc`, `anoisesrc`, `bandpass`) -- no samples, no libraries, so there
// is never a licence question and nothing to download. Pure: no I/O, no
// processes. `sfxCache.ts` runs this once per kind and caches the result.

export type SfxKind = 'boom' | 'whoosh' | 'pop'

export const SFX_KINDS: readonly SfxKind[] = ['boom', 'whoosh', 'pop']

const SAMPLE_RATE = 48000

interface SfxSpec {
  /** `-f lavfi -i` source: a self-contained generator, no external input. */
  source: string
  /** `-af` chain shaping the envelope (fade/decay) and level. */
  af: string
  durationSec: number
}

const SFX_SPECS: Record<SfxKind, SfxSpec> = {
  // A low sine sweeping 150 Hz -> 40 Hz with a fast exponential decay: a short thump, not a rumble.
  boom: {
    source: `aevalsrc=exprs='exp(-6*t)*sin(2*PI*(150*t-110*t*t))':sample_rate=${SAMPLE_RATE}:duration=0.5`,
    af: 'volume=0.9',
    durationSec: 0.5
  },
  // White noise through a band-pass whose centre frequency is swept up over
  // the clip's length (via asendcmd), with a fade in and out -- a whoosh.
  whoosh: {
    source: `anoisesrc=color=white:sample_rate=${SAMPLE_RATE}:duration=0.32:amplitude=1`,
    af: "asendcmd=c='0.0 bandpass@bp frequency 300;0.08 bandpass@bp frequency 700;0.16 bandpass@bp frequency 1400;0.24 bandpass@bp frequency 2200',bandpass@bp=frequency=300:width_type=o:width=1.2,afade=t=in:d=0.03,afade=t=out:st=0.2:d=0.12,volume=0.7",
    durationSec: 0.32
  },
  // A short, higher-pitched decaying tone: a soft click/blip.
  pop: {
    source: `aevalsrc=exprs='exp(-40*t)*sin(2*PI*900*t)':sample_rate=${SAMPLE_RATE}:duration=0.12`,
    af: 'volume=0.6',
    durationSec: 0.12
  }
}

/** How long the generated file for `kind` runs, before any per-cue gain is applied at mix time. */
export function sfxDuration(kind: SfxKind): number {
  return SFX_SPECS[kind].durationSec
}

/** Full FFmpeg argument list that renders `kind` to `outFile` (mono WAV at `SAMPLE_RATE`). */
export function buildSfxArgs(kind: SfxKind, outFile: string): string[] {
  const spec = SFX_SPECS[kind]
  return ['-hide_banner', '-nostdin', '-y', '-f', 'lavfi', '-i', spec.source, '-af', spec.af, '-ar', String(SAMPLE_RATE), '-ac', '1', '-c:a', 'pcm_s16le', '-t', spec.durationSec.toFixed(3), outFile]
}
