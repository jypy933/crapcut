import { ArrowLeft, Check, Clapperboard, Crop, FolderOpen, Music, Pause, Play, RotateCcw, Smartphone, Monitor, X } from 'lucide-react'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { editGroupText } from '@shared/captionEdit'
import { clipWords, groupWords, type CaptionGroup } from '@shared/captions'
import { CAPTION_STYLES } from '@shared/captionStyles'
import { formatClock, formatEta, formatLength } from '@shared/format'
import type { RenderFormat } from '@shared/layoutGeometry'
import { AUDIO_MODE_LABELS, type AppInfo, type AudioMode, type BestOfItem, type Clip, type ExportItem, type Layout, type Range } from '@shared/types'
import type { ClipPatch } from '@shared/ipc'
import { repairWordTimings } from '@shared/wordTiming'
import type { Route } from '../App'
import { api, call, errorText, useEvent } from '../api'
import { LayoutEditor } from '../components/LayoutEditor'
import { Preview } from '../components/Preview'
import { Timeline } from '../components/Timeline'
import { Field, ProgressBar, Segmented, Spinner, Toggle } from '../components/ui'
import { FALLBACK_LAYOUT } from '../lib/compose'

export function Review({ jobId, go }: { jobId: string; go: (r: Route) => void }): ReactNode {
  const [clips, setClips] = useState<Clip[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [layouts, setLayouts] = useState<Layout[]>([])
  const [exports, setExports] = useState<ExportItem[]>([])
  const [bestOf, setBestOf] = useState<BestOfItem[]>([])
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [format, setFormat] = useState<RenderFormat>('vertical')
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [editingLayout, setEditingLayout] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tuned, setTuned] = useState(false)
  const video = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    void call('clips:list', jobId).then((c) => {
      setClips(c)
      setSelected((s) => s ?? c[0]?.id ?? null)
    })
    void call('layouts:list').then((l) => setLayouts(l.layouts))
    void call('exports:list', jobId).then(setExports)
    void call('bestOf:list', jobId).then(setBestOf)
    void call('app:info').then(setInfo)
    void call('taste:status').then((s) => setTuned(s.tuned))
  }, [jobId])

  useEvent('exports:changed', (item) => {
    if (item.jobId !== jobId) return
    setExports((list) => {
      const i = list.findIndex((e) => e.id === item.id)
      if (i < 0) return [...list, item]
      const next = [...list]
      next[i] = item
      return next
    })
  })

  useEvent('bestOf:changed', (item) => {
    if (item.jobId !== jobId) return
    setBestOf((list) => {
      const i = list.findIndex((b) => b.id === item.id)
      if (i < 0) return [...list, item]
      const next = [...list]
      next[i] = item
      return next
    })
  })

  const clip = clips?.find((c) => c.id === selected) ?? null
  const layout = (clip?.layoutId && layouts.find((l) => l.id === clip.layoutId)) || FALLBACK_LAYOUT

  const update = useCallback(async (id: string, patch: ClipPatch): Promise<void> => {
    // Optimistic update so the UI stays snappy; main returns the checked clip.
    setClips((list) => list?.map((c) => (c.id === id ? ({ ...c, ...patch } as Clip) : c)) ?? null)
    try {
      const saved = await call('clips:update', id, patch)
      setClips((list) => list?.map((c) => (c.id === id ? saved : c)) ?? null)
    } catch (err) {
      setError(errorText(err))
    }
  }, [])

  const seek = useCallback(
    (t: number) => {
      const v = video.current
      if (!v || !clip?.source) return
      v.currentTime = Math.max(0, t - clip.source.start)
      setTime(t)
    },
    [clip?.source]
  )

  const togglePlay = useCallback(() => {
    const v = video.current
    if (!v || !clip?.source) return
    if (v.paused) {
      const t = clip.source.start + v.currentTime
      if (t < clip.start || t >= clip.end - 0.05) v.currentTime = clip.start - clip.source.start
      void v.play()
    } else v.pause()
  }, [clip])

  const move = useCallback(
    (delta: number) => {
      if (!clips?.length) return
      const i = clips.findIndex((c) => c.id === selected)
      const next = clips[Math.max(0, Math.min(clips.length - 1, i + delta))]
      if (next) setSelected(next.id)
    },
    [clips, selected]
  )

  // Keyboard: Space play, K keep, X skip, arrows move between clips.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const tag = (e.target as HTMLElement).tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || editingLayout || !clip) return
      if (e.key === ' ') {
        e.preventDefault()
        togglePlay()
      } else if (e.key.toLowerCase() === 'k') void update(clip.id, { status: 'accepted' })
      else if (e.key.toLowerCase() === 'x') void update(clip.id, { status: 'rejected' })
      else if (e.key === 'ArrowDown') {
        e.preventDefault()
        move(1)
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        move(-1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [clip, editingLayout, togglePlay, update, move])

  async function saveLayout(l: Layout, applyAll: boolean): Promise<void> {
    setEditingLayout(false)
    try {
      await call('layouts:save', l)
      await call('layouts:setDefault', l.id)
      setLayouts((await call('layouts:list')).layouts)
      const targets = applyAll ? (clips ?? []) : clip ? [clip] : []
      for (const c of targets) await update(c.id, { layoutId: l.id })
    } catch (err) {
      setError(errorText(err))
    }
  }

  const kept = clips?.filter((c) => c.status === 'accepted') ?? []
  const jobExports = exports.filter((e) => e.status !== 'cancelled')
  const activeBestOf = bestOf.find((b) => b.status === 'running' || b.status === 'queued') ?? null
  const lastBestOf = [...bestOf].reverse().find((b) => b.status !== 'cancelled') ?? null

  if (!clips) {
    return (
      <div className="page">
        <Spinner />
      </div>
    )
  }

  return (
    <div className="review">
      <aside className="review-list">
        <div className="head row">
          <button type="button" className="btn ghost icon" onClick={() => go({ name: 'home' })} title="Back">
            <ArrowLeft size={16} />
          </button>
          <div className="grow">
            <div style={{ fontWeight: 600 }}>{clips.length} {clips.length === 1 ? 'clip' : 'clips'}</div>
            <div className="small faint">{kept.length} kept{tuned ? ' · Tuned to your picks' : ''}</div>
          </div>
        </div>
        <div className="items">
          {clips.map((c) => (
            <div
              key={c.id}
              className={`clip-item${c.id === selected ? ' sel' : ''}${c.status === 'rejected' ? ' rejected' : ''}`}
              onClick={() => setSelected(c.id)}
              role="button"
              tabIndex={0}
            >
              <span className="rank">{c.rank}</span>
              <div className="grow">
                <div className="title ellipsis">{c.title}</div>
                <div className="small faint">
                  {formatLength(c.end - c.start)} · {formatClock(c.start)}
                </div>
              </div>
              {c.status === 'accepted' ? (
                <Check size={15} color="var(--good)" />
              ) : c.status === 'rejected' ? (
                <X size={15} color="var(--text-3)" />
              ) : (
                <span className="chip">{Math.round(c.score * 100)}</span>
              )}
            </div>
          ))}
        </div>
        <div className="foot col">
          <button
            type="button"
            className="btn primary"
            disabled={kept.length === 0}
            onClick={() => void call('exports:start', jobId, kept.map((c) => c.id)).catch((e) => setError(errorText(e)))}
          >
            {kept.length ? `Export ${kept.length} kept clip${kept.length > 1 ? 's' : ''}` : 'Keep clips to export them'}
          </button>
          <BestOfButton kept={kept.length} active={activeBestOf} last={lastBestOf} onStart={() => void call('bestOf:start', jobId).catch((e) => setError(errorText(e)))} />
          <div className="small faint" style={{ textAlign: 'center' }}>
            <kbd>K</kbd> keep · <kbd>X</kbd> skip · <kbd>Space</kbd> play
          </div>
        </div>
      </aside>

      <section className="stage">
        {clip ? (
          <>
            <div className="stage-top">
              <div className="grow ellipsis" style={{ fontWeight: 600, fontSize: 14 }}>
                {clip.title}
              </div>
              <div style={{ width: 200 }}>
                <Segmented<RenderFormat>
                  value={format}
                  onChange={setFormat}
                  options={[
                    { value: 'vertical', label: <><Smartphone size={13} /> 9:16</> },
                    { value: 'horizontal', label: <><Monitor size={13} /> 16:9</> }
                  ]}
                />
              </div>
            </div>
            {clip.source ? (
              <Preview
                clip={clip}
                src={api.clipUrl(jobId, clip.id)}
                layout={layout}
                format={format}
                videoRef={video}
                time={time}
                onTime={setTime}
                onPlaying={setPlaying}
                onCaptionY={(y) => void update(clip.id, { captions: { ...clip.captions, y } })}
              />
            ) : (
              <div className="viewport muted">This clip's video has not been downloaded.</div>
            )}
            {clip.source && (
              <div className="transport">
                <button type="button" className="btn icon" onClick={togglePlay} title={playing ? 'Pause' : 'Play'}>
                  {playing ? <Pause size={15} /> : <Play size={15} />}
                </button>
                <Timeline
                  bounds={clip.source}
                  value={{ start: clip.start, end: clip.end }}
                  time={time}
                  words={clip.words}
                  onSeek={seek}
                  onChange={(r: Range) => void update(clip.id, { start: r.start, end: r.end })}
                />
                <span className="small muted" style={{ width: 92, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
                  {formatLength(Math.max(0, time - clip.start))} / {formatLength(clip.end - clip.start)}
                </span>
              </div>
            )}
          </>
        ) : (
          <div className="viewport muted">No clips were found.</div>
        )}
        {error && (
          <div className="error small" onClick={() => setError(null)}>
            {error}
          </div>
        )}
        {jobExports.length > 0 && <ExportsBar items={jobExports} clips={clips} />}
      </section>

      {clip && (
        <Inspector
          clip={clip}
          layouts={layouts}
          time={time}
          voiceAvailable={info?.features.voiceSeparation ?? false}
          onUpdate={(p) => void update(clip.id, p)}
          onSeek={seek}
          onEditLayout={() => {
            video.current?.pause()
            setEditingLayout(true)
          }}
          onReset={() =>
            void call('clips:reset', clip.id).then((saved) => setClips((l) => l?.map((c) => (c.id === saved.id ? saved : c)) ?? null))
          }
          onPickMusic={() =>
            void call('clips:pickMusic', clip.id).then((saved) => saved && setClips((l) => l?.map((c) => (c.id === saved.id ? saved : c)) ?? null))
          }
        />
      )}

      {editingLayout && clip?.source && (
        <LayoutEditor
          src={api.clipUrl(jobId, clip.id)}
          at={Math.max(0, time - clip.source.start)}
          initial={clip.layoutId ? (layouts.find((l) => l.id === clip.layoutId) ?? null) : (layouts[0] ?? null)}
          onCancel={() => setEditingLayout(false)}
          onSave={(l, all) => void saveLayout(l, all)}
        />
      )}
    </div>
  )
}

function Inspector({
  clip,
  layouts,
  time,
  voiceAvailable,
  onUpdate,
  onSeek,
  onEditLayout,
  onReset,
  onPickMusic
}: {
  clip: Clip
  layouts: Layout[]
  time: number
  voiceAvailable: boolean
  onUpdate: (p: ClipPatch) => void
  onSeek: (t: number) => void
  onEditLayout: () => void
  onReset: () => void
  onPickMusic: () => void
}): ReactNode {
  const [title, setTitle] = useState(clip.title)
  useEffect(() => setTitle(clip.title), [clip.id, clip.title])
  // Repaired once and reused for both the groups shown here and the words
  // passed to caption editing, so the two agree on exact timings (`clipWords`
  // repairs internally too, but idempotently, so this stays in sync with it).
  const words = useMemo(() => repairWordTimings(clip.words), [clip.words])
  const groups = useMemo(() => groupWords(clipWords(words, clip.start, clip.end)), [words, clip.start, clip.end])
  const edited = clip.start !== clip.suggested.start || clip.end !== clip.suggested.end
  // A clip saved before the chat overlay existed has neither field yet (main
  // normalises on read, but this stays cheap insurance).
  const chatMessages = clip.chatMessages ?? []

  return (
    <aside className="inspector">
      <Field label="Title">
        <input
          className="input"
          value={title}
          maxLength={100}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={() => title.trim() && title !== clip.title && onUpdate({ title })}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </Field>

      <Segmented<'accepted' | 'rejected' | 'pending'>
        value={clip.status}
        onChange={(status) => onUpdate({ status })}
        options={[
          { value: 'accepted', label: <><Check size={14} /> Keep</> },
          { value: 'rejected', label: <><X size={14} /> Skip</> }
        ]}
      />

      <Field label="Formats">
        <div className="row">
          <label className="row grow small">
            <Toggle on={clip.formats.vertical} label="Vertical 9:16" onChange={(v) => onUpdate({ formats: { ...clip.formats, vertical: v || !clip.formats.horizontal } })} />
            Vertical 9:16
          </label>
          <label className="row grow small">
            <Toggle on={clip.formats.horizontal} label="Horizontal 16:9" onChange={(v) => onUpdate({ formats: { ...clip.formats, horizontal: v || !clip.formats.vertical } })} />
            16:9
          </label>
        </div>
      </Field>

      <Field
        label="Layout"
        right={
          <button type="button" className="btn sm ghost" onClick={onEditLayout}>
            <Crop size={13} /> {layouts.length ? 'Edit' : 'Mark facecam'}
          </button>
        }
      >
        <select className="input" value={clip.layoutId ?? ''} onChange={(e) => onUpdate({ layoutId: e.target.value || null })}>
          <option value="">Full frame (blurred edges)</option>
          {layouts.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </Field>

      <Field
        label="Captions"
        right={<Toggle on={clip.captions.enabled} label="Captions" onChange={(enabled) => onUpdate({ captions: { ...clip.captions, enabled } })} />}
      >
        {clip.captions.enabled && (
          <>
            <select
              className="input"
              aria-label="Caption style"
              value={clip.captions.styleId}
              onChange={(e) => onUpdate({ captions: { ...clip.captions, styleId: e.target.value as Clip['captions']['styleId'] } })}
            >
              {CAPTION_STYLES.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
            <label className="row small muted">
              <Toggle on={clip.captions.uppercase} label="Uppercase" onChange={(uppercase) => onUpdate({ captions: { ...clip.captions, uppercase } })} />
              UPPERCASE
            </label>
            <CaptionLines clip={clip} words={words} groups={groups} time={time} onSeek={onSeek} onWords={(newWords) => onUpdate({ words: newWords })} />
            <div className="small faint">Drag the captions on the video to move them.</div>
          </>
        )}
      </Field>

      <Field
        label="Chat"
        right={
          <Toggle
            on={clip.chatOverlay ?? false}
            label="Chat"
            disabled={chatMessages.length === 0}
            onChange={(chatOverlay) => onUpdate({ chatOverlay })}
          />
        }
      >
        {chatMessages.length === 0 && <div className="small faint">No chat in this clip's time range.</div>}
      </Field>

      <Field label="Audio">
        <div className="col" style={{ gap: 4 }}>
          {(Object.keys(AUDIO_MODE_LABELS) as AudioMode[]).map((m) => {
            const needsVoice = m !== 'original'
            const disabled = needsVoice && !voiceAvailable
            return (
              <label key={m} className={`row small${disabled ? ' faint' : ''}`} style={{ cursor: disabled ? 'default' : 'pointer' }} title={disabled ? 'Voice separation arrives in a later update.' : undefined}>
                <input type="radio" name="audio" checked={clip.audio === m} disabled={disabled} onChange={() => (m === 'voice_music' && !clip.musicPath ? onPickMusic() : onUpdate({ audio: m }))} />
                <span className="grow">{AUDIO_MODE_LABELS[m]}</span>
                {m === 'voice_music' && clip.audio === 'voice_music' && (
                  <button type="button" className="btn sm ghost" onClick={onPickMusic}>
                    <Music size={12} /> {clip.musicPath ? (clip.musicPath.split(/[\\/]/).pop() ?? '').slice(0, 18) : 'Choose'}
                  </button>
                )}
              </label>
            )
          })}
        </div>
      </Field>

      <div className="divider" />
      <div className="col small faint">
        <span>{clip.reason}</span>
        <span>
          At {formatClock(clip.start)} in the stream · score {Math.round(clip.score * 100)}
        </span>
        {edited && (
          <button type="button" className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={onReset}>
            <RotateCcw size={12} /> Reset cut
          </button>
        )}
      </div>
    </aside>
  )
}

function CaptionLines({
  clip,
  words,
  groups,
  time,
  onSeek,
  onWords
}: {
  clip: Clip
  /** `clip.words`, already repaired: matches the (also repaired) words inside `groups` exactly. */
  words: Clip['words']
  groups: CaptionGroup[]
  time: number
  onSeek: (t: number) => void
  onWords: (w: Clip['words']) => void
}): ReactNode {
  const rel = time - clip.start
  return (
    <div className="caption-lines">
      {groups.length === 0 && <div className="small faint">No speech in this clip.</div>}
      {groups.map((g, i) => (
        <CaptionLine
          key={`${clip.id}-${g.start}-${i}`}
          group={g}
          now={rel >= g.start && rel < g.end}
          onSeek={() => onSeek(clip.start + g.start)}
          onText={(text) => {
            // `g` is clip-relative; `words` (clip.words) is in VOD time, so
            // pass clip.start to line the two up.
            onWords(editGroupText(words, g, text, clip.start))
          }}
        />
      ))}
    </div>
  )
}

function CaptionLine({ group, now, onSeek, onText }: { group: CaptionGroup; now: boolean; onSeek: () => void; onText: (t: string) => void }): ReactNode {
  const original = group.words.map((w) => w.text).join(' ')
  const [text, setText] = useState(original)
  useEffect(() => setText(original), [original])
  return (
    <div className={`caption-line${now ? ' now' : ''}`}>
      <span className="t" onClick={onSeek}>
        {formatLength(group.start)}
      </span>
      <input
        className="input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={() => text !== original && onText(text)}
        onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        spellCheck={false}
      />
    </div>
  )
}

function BestOfButton({ kept, active, last, onStart }: { kept: number; active: BestOfItem | null; last: BestOfItem | null; onStart: () => void }): ReactNode {
  if (active) {
    return (
      <div className="col" style={{ gap: 4 }}>
        <div className="row small faint">
          <span className="grow">Building the best-of video...</span>
          <span>{formatEta(active.etaSec) ?? `${Math.round(active.progress * 100)}%`}</span>
        </div>
        <ProgressBar value={active.progress} />
      </div>
    )
  }
  return (
    <div className="col" style={{ gap: 4 }}>
      <button type="button" className="btn ghost" disabled={kept === 0} onClick={onStart} title="Join the kept clips into one 16:9 video with crossfades">
        <Clapperboard size={14} /> Best of
      </button>
      {last?.status === 'done' && (
        <button type="button" className="btn sm ghost" onClick={() => void call('bestOf:show', last.id)}>
          <FolderOpen size={12} /> Show best-of video
        </button>
      )}
      {last?.status === 'failed' && <span className="small error">{last.error ?? 'The best-of video could not be built.'}</span>}
    </div>
  )
}

function ExportsBar({ items, clips }: { items: ExportItem[]; clips: Clip[] }): ReactNode {
  return (
    <div className="exports">
      <div className="row">
        <span className="label grow">Exports</span>
        <button type="button" className="btn sm ghost" onClick={() => void call('app:openOutputFolder')}>
          <FolderOpen size={13} /> Open folder
        </button>
      </div>
      {items.map((e) => {
        const c = clips.find((x) => x.id === e.clipId)
        const eta = formatEta(e.etaSec)
        return (
          <div key={e.id} className="export-row small">
            <span className="ellipsis">
              {c?.title ?? 'Clip'} <span className="faint">· {e.format === 'vertical' ? '9:16' : '16:9'}</span>
            </span>
            {e.status === 'running' ? <ProgressBar value={e.progress} /> : <span className={e.status === 'failed' ? 'error' : 'faint'}>{e.status === 'failed' ? (e.error ?? 'Failed') : e.status === 'done' ? 'Done' : e.status === 'queued' ? 'Waiting' : ''}</span>}
            <span style={{ textAlign: 'right' }}>
              {e.status === 'done' ? (
                <button type="button" className="btn sm ghost" onClick={() => void call('exports:show', e.id)}>
                  Show
                </button>
              ) : e.status === 'running' ? (
                <span className="faint">{eta ?? `${Math.round(e.progress * 100)}%`}</span>
              ) : e.status === 'queued' ? (
                <button type="button" className="btn sm ghost" onClick={() => void call('exports:cancel', e.id)}>
                  Cancel
                </button>
              ) : null}
            </span>
          </div>
        )
      })}
    </div>
  )
}
