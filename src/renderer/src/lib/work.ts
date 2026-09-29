// Live state of exports and best-of builds across all jobs, and a slow clock,
// shared by the home screen and the always-visible progress indicator.

import { useEffect, useState } from 'react'
import type { BestOfItem, ExportItem } from '@shared/types'
import { call, useEvent } from '../api'

export interface Work {
  exports: ExportItem[]
  bestOf: BestOfItem[]
  /** When each item was last heard about (epoch ms), so a stalled one's time left can go stale. */
  seenAt: Record<string, number>
}

/** The items with the time they were last heard about, as `summarizeWork` wants them. */
export function seen<T extends { id: string }>(items: T[], seenAt: Record<string, number>): (T & { seenAt: number })[] {
  return items.map((i) => ({ ...i, seenAt: seenAt[i.id] ?? 0 }))
}

/** True while anything is queued or running. */
export function hasActiveWork(work: Work): boolean {
  return [...work.exports, ...work.bestOf].some((i) => i.status === 'queued' || i.status === 'running')
}

function upsert<T extends { id: string }>(list: T[], item: T): T[] {
  const i = list.findIndex((x) => x.id === item.id)
  if (i < 0) return [...list, item]
  const next = [...list]
  next[i] = item
  return next
}

export function useWork(): Work {
  const [work, setWork] = useState<Work>({ exports: [], bestOf: [], seenAt: {} })
  useEffect(() => {
    void call('work:list').then((w) => {
      const at = Date.now()
      setWork({ ...w, seenAt: Object.fromEntries([...w.exports, ...w.bestOf].map((i) => [i.id, at])) })
    })
  }, [])
  useEvent('exports:changed', (item) => setWork((w) => ({ ...w, exports: upsert(w.exports, item), seenAt: { ...w.seenAt, [item.id]: Date.now() } })))
  useEvent('bestOf:changed', (item) => setWork((w) => ({ ...w, bestOf: upsert(w.bestOf, item), seenAt: { ...w.seenAt, [item.id]: Date.now() } })))
  return work
}

/** Date.now(), refreshed every few seconds while `active`, so a stale time left can drop away. */
export function useNow(active: boolean, everyMs = 5000): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    setNow(Date.now())
    const t = setInterval(() => setNow(Date.now()), everyMs)
    return () => clearInterval(t)
  }, [active, everyMs])
  return active ? now : Date.now()
}
