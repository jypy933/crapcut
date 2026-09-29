// Time-left estimates from progress samples. The rate comes from a sliding
// window and is smoothed over time, so a slow start, a burst or a brief stall
// does not make the estimate jump around. It says nothing (null) until it has
// watched long enough and seen enough progress to be trusted, and again after
// a stall.

export interface EtaOptions {
  /** Watch at least this long (seconds) before saying anything. */
  minElapsedSec: number
  /** ...and see at least this share (0..1) of the whole job done since the first sample. */
  minFraction: number
  /** No progress for this long counts as a stall: say nothing and start watching afresh. */
  stallMs: number
  /** Time constant of the rate smoothing; longer is steadier but slower to follow a real change. */
  smoothingMs: number
}

const DEFAULTS: EtaOptions = { minElapsedSec: 5, minFraction: 0.01, stallMs: 30_000, smoothingMs: 5000 }

/** Longer than this is a guess, not an estimate. */
const MAX_ETA_SEC = 48 * 3600

export class EtaEstimator {
  private samples: { t: number; done: number }[] = []
  /** When and where this watch began (the first sample, or the one after a stall). */
  private start: { t: number; done: number } | null = null
  private lastAdvance = 0
  private rate: number | null = null
  private rateAt = 0
  private readonly opts: EtaOptions

  constructor(
    private readonly windowMs = 30_000,
    private readonly now: () => number = () => Date.now(),
    opts: Partial<EtaOptions> = {}
  ) {
    this.opts = { ...DEFAULTS, ...opts }
  }

  reset(): void {
    this.samples = []
    this.start = null
    this.rate = null
  }

  /**
   * Records progress (any unit, e.g. bytes or 0..1) and returns the seconds
   * left, or null while there is not enough data to say.
   */
  update(done: number, total: number): number | null {
    const t = this.now()
    // Progress that goes backwards means the work restarted; a long gap without
    // progress is a stall. Either way forget what we saw, so the gap does not
    // drag the next estimate down.
    const before = this.samples.at(-1)
    if (before && (done < before.done || t - this.lastAdvance >= this.opts.stallMs)) this.reset()
    const prev = this.samples.at(-1)
    if (!prev || done > prev.done) this.lastAdvance = t
    this.start ??= { t, done }
    this.samples.push({ t, done })
    while (this.samples.length > 2 && t - this.samples[0]!.t > this.windowMs) this.samples.shift()

    if (done >= total) return 0
    const first = this.samples[0]!
    const dt = (t - first.t) / 1000
    const progressed = done - first.done
    if (dt < 2 || progressed <= 0) return null

    // Smooth the rate over time, not per call, so how often we are called does not matter.
    const windowRate = progressed / dt
    if (this.rate === null) this.rate = windowRate
    else this.rate += (1 - Math.exp(-(t - this.rateAt) / this.opts.smoothingMs)) * (windowRate - this.rate)
    this.rateAt = t

    const seen = (t - this.start.t) / 1000
    if (seen < this.opts.minElapsedSec || (done - this.start.done) / total < this.opts.minFraction) return null
    const eta = Math.round((total - done) / this.rate)
    return eta > MAX_ETA_SEC ? null : Math.max(0, eta)
  }
}
