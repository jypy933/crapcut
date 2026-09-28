// Only one AI model runs at a time (whisper, the language model, stem
// separation) so they never fight over video memory.

import { CancelledError } from '../util/errors'

export class GpuLock {
  private tail: Promise<void> = Promise.resolve()

  /** Waits for the GPU; call the returned function to release it. */
  async acquire(signal?: AbortSignal): Promise<() => void> {
    let release!: () => void
    const mine = new Promise<void>((r) => (release = r))
    const prev = this.tail
    this.tail = prev.then(() => mine)
    if (signal) {
      await Promise.race([
        prev,
        new Promise<never>((_, reject) => {
          if (signal.aborted) reject(new CancelledError())
          signal.addEventListener('abort', () => reject(new CancelledError()), { once: true })
        })
      ]).catch((err) => {
        // Give up our place without blocking whoever is behind us.
        prev.then(release, release)
        throw err
      })
    } else {
      await prev
    }
    let released = false
    return () => {
      if (!released) {
        released = true
        release()
      }
    }
  }
}
