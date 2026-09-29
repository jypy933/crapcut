// Human-friendly formatting shared by main and renderer.

/** "about 3 min", "about 1 h 20 min", "less than a minute". */
export function formatEta(sec: number | null): string | null {
  if (sec === null || !Number.isFinite(sec)) return null
  if (sec < 60) return 'less than a minute'
  const min = Math.round(sec / 60)
  if (min < 60) return `about ${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `about ${h} h ${m} min` : `about ${h} h`
}

/** The same, tight: "3 min", "1 h 20 min", "<1 min". */
export function formatEtaShort(sec: number | null): string | null {
  if (sec === null || !Number.isFinite(sec)) return null
  if (sec < 60) return '<1 min'
  const min = Math.round(sec / 60)
  if (min < 60) return `${min} min`
  const h = Math.floor(min / 60)
  const m = min % 60
  return m ? `${h} h ${m} min` : `${h} h`
}

/** 1.2 GB, 850 MB, 12 KB. */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 MB'
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`
  const mb = bytes / 1024 ** 2
  if (mb >= 1) return `${mb.toFixed(0)} MB`
  return `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** 3725.4 -> "1:02:05"; 65 -> "1:05". */
export function formatClock(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const r = s % 60
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}` : `${m}:${String(r).padStart(2, '0')}`
}

/** 34.56 -> "34.6 s"; 75 -> "1:15". */
export function formatLength(sec: number): string {
  return sec < 60 ? `${sec.toFixed(1)} s` : formatClock(sec)
}
