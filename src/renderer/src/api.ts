// Thin wrappers over the preload API.

import { useEffect, useRef } from 'react'
import type { z } from 'zod'
import type { EventChannel, Events, Invoke, InvokeChannel, InvokeResult } from '@shared/ipc'

export const api = window.crapcut

export type CallArgs<C extends InvokeChannel> = z.infer<(typeof Invoke)[C]>

export function call<C extends InvokeChannel>(channel: C, ...args: CallArgs<C>): Promise<InvokeResult[C]> {
  return api.invoke(channel, ...args)
}

/** Subscribes to a main-process event for the component's lifetime. */
export function useEvent<E extends EventChannel>(event: E, listener: (payload: Events[E]) => void): void {
  const ref = useRef(listener)
  ref.current = listener
  useEffect(() => api.on(event, (p) => ref.current(p)), [event])
}

/** The plain sentence from a failed call (main never sends details). */
export function errorText(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err)
  return msg.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') || 'Something went wrong.'
}
