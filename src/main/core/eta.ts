// Time-left estimates from progress samples over a sliding window, so a slow
// start or a brief stall does not make the estimate jump around.

export class EtaEstimator {
  private samples: { t: number; done: number }[] = []

  constructor(
    private readonly windowMs = 30_000,
    private readonly now: () => number = () => Date.now()
  ) {}

  reset(): void {
    this.samples = []
  }

  /**
   * Records progress (any unit, e.g. bytes or 0..1) and returns the seconds
   * left, or null until there is enough data.
   */
  update(done: number, total: number): number | null {
    const t = this.now()
    this.samples.push({ t, done })
    while (this.samples.length > 2 && t - this.samples[0]!.t > this.windowMs) this.samples.shift()
    const first = this.samples[0]!
    const dt = (t - first.t) / 1000
    const progressed = done - first.done
    if (dt < 2 || progressed <= 0) return null
    const rate = progressed / dt
    return Math.max(0, Math.round((total - done) / rate))
  }
}
