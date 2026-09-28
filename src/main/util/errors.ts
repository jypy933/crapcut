// Errors carry two messages: a plain sentence for the user and details for the log.

export class UserError extends Error {
  /** One plain sentence the user can read. */
  readonly userMessage: string
  /** Retrying could help (network hiccup, busy GPU...). */
  readonly retryable: boolean

  constructor(userMessage: string, opts: { cause?: unknown; retryable?: boolean; detail?: string } = {}) {
    super(opts.detail ?? userMessage, { cause: opts.cause })
    this.name = 'UserError'
    this.userMessage = userMessage
    this.retryable = opts.retryable ?? true
  }
}

export class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

export function isCancelled(err: unknown): boolean {
  return err instanceof CancelledError || (err instanceof Error && err.name === 'AbortError')
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new CancelledError()
}

/** The sentence to show the user for any error. */
export function userMessage(err: unknown, fallback: string): string {
  if (err instanceof UserError) return err.userMessage
  return fallback
}
