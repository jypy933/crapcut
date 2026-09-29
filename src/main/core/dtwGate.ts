// Keeps whisper.cpp's DTW word timing from ever costing a transcript. DTW is
// the least tested part of whisper.cpp (and cannot be tried on every GPU
// here), so a run that fails with it is redone without it, and a job that
// keeps getting no usable DTW times stops asking for them.

/** After this many chunks where DTW failed or gave nothing, a job stops asking for it. */
export const MAX_DTW_FAILURES = 2

export class DtwGate {
  private failures = 0

  get enabled(): boolean {
    return this.failures < MAX_DTW_FAILURES
  }

  /** Notes one chunk where DTW failed or gave no usable times; true when that switched DTW off for the job. */
  failed(): boolean {
    const was = this.enabled
    this.failures++
    return was && !this.enabled
  }
}

export interface DtwRun<T> {
  result: T
  /** Whether the run that produced `result` had DTW on. */
  dtw: boolean
  /** Whether a run with DTW failed first and `result` is from the redo without it. */
  retried: boolean
}

/**
 * Runs `run` with DTW; if that fails (anything but a cancel) runs it again
 * without. `onRetry` is for the log. When the run without DTW fails too, that
 * error is thrown: the fault was not DTW's.
 */
export async function runWithDtwFallback<T>(
  dtw: string | null,
  run: (dtw: string | null) => Promise<T>,
  isCancel: (err: unknown) => boolean,
  onRetry: (err: unknown) => void
): Promise<DtwRun<T>> {
  if (!dtw) return { result: await run(null), dtw: false, retried: false }
  try {
    return { result: await run(dtw), dtw: true, retried: false }
  } catch (err) {
    if (isCancel(err)) throw err
    onRetry(err)
    return { result: await run(null), dtw: false, retried: true }
  }
}
