import { ArrowLeft, Check, Clapperboard, Crop, FolderOpen, Music, Pause, Play, RotateCcw, Smartphone, Monitor, Sparkles, Wand2, X } from 'lucide-react'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { editGroupText } from '@shared/captionEdit'
import { clipWords, groupWords, type CaptionGroup } from '@shared/captions'
import { CAPTION_STYLES } from '@shared/captionStyles'
import { PLATFORMS, type Platform } from '@shared/editPlan'
import { formatClock, formatEta, formatLength } from '@shared/format'
import { chosenVersion, hasColdOpen, PLATFORM_LABELS, platformsOverCap, type ClipVersion } from '@shared/platformExport'
import type { RenderFormat } from '@shared/layoutGeometry'
import { AUDIO_MODE_LABELS, type AppInfo, type AudioMode, type AutoEditPreviewState, type BestOfItem, type Clip, type ExportItem, type Layout, type Range } from '@shared/types'
import type { ClipPatch } from '@shared/ipc'
import { repairWordTimings } from '@shared/wordTiming'
import type { Route } from '../App'
import { api, call, errorText, useEvent } from '../api'
import { LayoutEditor } from '../components/LayoutEditor'
import { Preview } from '../components/Preview'
import { Timeline } from '../components/Timeline'
import { Field, ProgressBar, Segmented, Spinner, Toggle } from '../components/ui'
import { FALLBACK_LAYOUT } from '../lib/compose'

const OFF_PREVIEW: AutoEditPreviewState = { clipId: '', status: 'off', version: null }

/** Marked as one of the job's clearly best moments (it started out accepted); not shown once he skips it. */
const isTopPick = (c: Clip): boolean => c.virality?.topPick === true && c.status !== 'rejected'

export function Review({ jobId, go }: { jobId: string; go: (r: Route) => void }): ReactNode {
  const [clips, setClips] = useState<Clip[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [layouts, setLayouts] = useState<Layout[]>([])
  const [defaultLayoutId, setDefaultLayoutId] = useState<string | null>(null)
  const [exports, setExports] = useState<ExportItem[]>([])
  const [bestOf, setBestOf] = useState<BestOfItem[]>([])
  const [info, setInfo] = useState<AppInfo | null>(null)
  const [format, setFormat] = useState<RenderFormat>('vertical')
  const [time, setTime] = useState(0)
  const [playing, setPlaying] = useState(false)
  const [editingLayout, setEditingLayout] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [tuned, setTuned] = useState(false)
  const [stageTab, setStageTab] = useState<'editor' | 'autoEdit'>('editor')
  const [previews, setPreviews] = useState<Record<string, AutoEditPreviewState>>({})
  const [platforms, setPlatforms] = useState<Platform[]>([...PLATFORMS])
  const video = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    void call('clips:list', jobId).then((c) => {
      setClips(c)
      setSelected((s) => s ?? c[0]?.id ?? null)
    })
    void call('layouts:list').then((l) => {
      setLayouts(l.layouts)
      setDefaultLayoutId(l.defaultId)
    })
    void call('exports:list', jobId).then(setExports)
    void call('bestOf:list', jobId).then(setBestOf)
    void call('app:info').then(setInfo)
    void call('taste:status').then((s) => setTuned(s.tuned))
    void call('settings:getExportPlatforms').then(setPlatforms)
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

  useEvent('autoEditPreview:changed', (state) => {
    setPreviews((m) => ({ ...m, [state.clipId]: state }))
    // Building a preview refreshes the clip's edit plan (a trim can add or remove its cold open); take the new plan, nothing else.
    if (state.status === 'ready') {
      void call('clips:list', jobId).then((fresh) =>
        setClips((list) =>
          list?.map((c) => {
            const f = fresh.find((x) => x.id === c.id)
            return !f || JSON.stringify(f.editPlan) === JSON.stringify(c.editPlan) ? c : { ...c, editPlan: f.editPlan }
          }) ?? null
        )
      )
    }
  })

  const clip = clips?.find((c) => c.id === selected) ?? null
  const layout = (clip?.layoutId && layouts.find((l) => l.id === clip.layoutId)) || FALLBACK_LAYOUT

  // Asks main for the current auto-edit preview whenever the clip (a fresh
  // object on every accepted edit) or the format changes; main debounces and
  // caches, so calling this often -- including mid-drag on the trim handles
  // -- is cheap.
  useEffect(() => {
    if (!clip || !clip.autoEdit) return
    void call('clips:previewAutoEdit', clip.id, format).then((state) => setPreviews((m) => ({ ...m, [state.clipId]: state })))
  }, [clip, format])

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

  async function useLayout(id: string, applyAll: boolean): Promise<void> {
    const targets = applyAll ? (clips ?? []) : clip ? [clip] : []
    for (const c of targets) await update(c.id, { layoutId: id })
  }

  // A deleted layout falls back to the plain full frame, here and at export.
  async function layoutDeleted(id: string): Promise<void> {
    for (const c of clips ?? []) if (c.layoutId === id) await update(c.id, { layoutId: null })
  }

  const kept = clips?.filter((c) => c.status === 'accepted') ?? []
  const keptVertical = kept.some((c) => c.formats.vertical)

  // At least one platform stays ticked; the choice is remembered for next time.
  function togglePlatform(p: Platform): void {
    const next = platforms.includes(p) ? platforms.filter((x) => x !== p) : PLATFORMS.filter((x) => x === p || platforms.includes(x))
    if (next.length === 0) return
    setPlatforms(next)
    void call('settings:setExportPlatforms', next).then(setPlatforms)
  }
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
                  {isTopPick(c) && (
                    <span className="top-pick" title="One of the best moments in this stream">
                      <Sparkles size={11} /> Top pick
                    </span>
                  )}
                </div>
              </div>
              {c.status === 'accepted' ? <Check size={15} color="var(--good)" /> : c.status === 'rejected' ? <X size={15} color="var(--text-3)" /> : null}
            </div>
          ))}
        </div>
        <div className="foot col">
          {keptVertical && (
            <div className="col" style={{ gap: 4 }}>
              <span className="small faint">Post vertical clips to</span>
              <div className="segmented" role="group" aria-label="Post vertical clips to">
                {PLATFORMS.map((p) => (
                  <button key={p} type="button" aria-pressed={platforms.includes(p)} className={platforms.includes(p) ? 'on' : ''} onClick={() => togglePlatform(p)}>
                    {PLATFORM_LABELS[p]}
                  </button>
                ))}
              </div>
            </div>
          )}
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
              <div style={{ width: 160 }}>
                <Segmented<'editor' | 'autoEdit'>
                  value={stageTab}
                  onChange={setStageTab}
                  options={[
                    { value: 'editor', label: 'Editor' },
                    { value: 'autoEdit', label: <><Wand2 size={13} /> Auto edit</> }
                  ]}
                />
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
              stageTab === 'editor' ? (
                <Preview
                  clip={clip}
                  src={api.clipUrl(jobId, clip.id)}
                  layout={layout}
                  format={format}
                  videoRef={video}
                  onTime={setTime}
                  onPlaying={setPlaying}
                  onCaptions={(captions) => void update(clip.id, { captions })}
                  onChatPos={(chatPos) => void update(clip.id, { chatPos })}
                />
              ) : (
                <AutoEditPreviewPane jobId={jobId} clip={clip} state={previews[clip.id] ?? OFF_PREVIEW} />
              )
            ) : (
              <div className="viewport muted">This clip's video has not been downloaded.</div>
            )}
            {clip.source && stageTab === 'editor' && (
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
          defaultLayoutId={defaultLayoutId}
          time={time}
          voiceAvailable={info?.features.voiceSeparation ?? false}
          platforms={platforms}
          onUpdate={(p) => {
            // Picking a version shows it: the Auto edit tab plays the chosen one.
            if (p.version) setStageTab('autoEdit')
            void update(clip.id, p)
          }}
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
          layouts={layouts}
          defaultId={defaultLayoutId}
          clipLayoutId={clip.layoutId}
          onClose={() => setEditingLayout(false)}
          onChanged={(list, def) => {
            setLayouts(list)
            setDefaultLayoutId(def)
          }}
          onDeleted={(id) => void layoutDeleted(id)}
          onUse={(id, all) => void useLayout(id, all)}
        />
      )}
    </div>
  )
}

/** The "Auto edit" tab: the cached preview of the clip's automatic re-edit, or a plain status while it is not ready. */
function AutoEditPreviewPane({ jobId, clip, state }: { jobId: string; clip: Clip; state: AutoEditPreviewState }): ReactNode {
  if (!clip.autoEdit) {
    return <div className="viewport muted">Auto edit is off for this clip.</div>
  }
  if (state.status === 'error') {
    return <div className="viewport muted">The auto edit preview could not be built.</div>
  }
  if (state.status !== 'ready' || !state.version) {
    return (
      <div className="viewport muted">
        <Spinner size={18} />
      </div>
    )
  }
  return (
    <div className="viewport">
      <video key={state.version} className="autoedit-preview" src={api.previewUrl(jobId, clip.id, state.version)} controls autoPlay loop />
    </div>
  )
}

function Inspector({
  clip,
  layouts,
  defaultLayoutId,
  time,
  voiceAvailable,
  platforms,
  onUpdate,
  onSeek,
  onEditLayout,
  onReset,
  onPickMusic
}: {
  clip: Clip
  layouts: Layout[]
  defaultLayoutId: string | null
  time: number
  voiceAvailable: boolean
  platforms: Platform[]
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
  const overCap = platformsOverCap(clip, platforms)

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

      <Field label="Auto edit" right={<Toggle on={clip.autoEdit} label="Auto edit" onChange={(autoEdit) => onUpdate({ autoEdit })} />}>
        {/* The one calm choice between the two versions; there is nothing to choose without a cold open. */}
        {hasColdOpen(clip) && (
          <Segmented<ClipVersion>
            value={chosenVersion(clip)}
            onChange={(version) => onUpdate({ version })}
            options={[
              { value: 'straight', label: 'Straight' },
              { value: 'coldOpen', label: 'Cold open', title: 'Starts on the big moment, then goes back to the beginning' }
            ]}
          />
        )}
      </Field>

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
        {clip.formats.vertical && overCap.length > 0 && (
          <div className="small faint">{overCap.map((p) => PLATFORM_LABELS[p]).join(' and ')}: over the length limit, so it ends early or is left out.</div>
        )}
      </Field>

      <Field
        label="Layout"
        right={
          <button type="button" className="btn sm ghost" onClick={onEditLayout}>
            <Crop size={13} /> {layouts.length ? 'Layouts' : 'Mark facecam'}
          </button>
        }
      >
        <select className="input" value={clip.layoutId ?? ''} onChange={(e) => onUpdate({ layoutId: e.target.value || null })}>
          <option value="">Full frame (blurred edges)</option>
          {layouts.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
              {l.id === defaultLayoutId ? ' (default)' : ''}
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
            <div className="small faint">Drag the captions (and the chat) on the video to move them.</div>
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
          At {formatClock(clip.start)} in the stream{isTopPick(clip) ? ' · Top pick' : ''}
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
        // A platform left out for this clip has no file; its note says why.
        const left = e.status === 'done' && !e.file && !!e.note
        return (
          <Fragment key={e.id}>
            <div className="export-row small">
              {/* The title shortens, the platform after it never does. */}
              <span className="row" style={{ minWidth: 0, gap: 4 }}>
                <span className="ellipsis">{c?.title ?? 'Clip'}</span>
                <span className="faint" style={{ flex: 'none' }}>· {e.platform ? PLATFORM_LABELS[e.platform] : e.format === 'vertical' ? '9:16' : '16:9'}</span>
              </span>
              {e.status === 'running' ? <ProgressBar value={e.progress} /> : <span className={e.status === 'failed' ? 'error' : 'faint'}>{e.status === 'failed' ? (e.error ?? 'Failed') : left ? 'Left out' : e.status === 'done' ? 'Done' : e.status === 'queued' ? 'Waiting' : ''}</span>}
              <span style={{ textAlign: 'right' }}>
                {e.status === 'done' && e.file ? (
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
            {e.status === 'done' && e.note && <div className="small faint export-note">{e.note}</div>}
          </Fragment>
        )
      })}
    </div>
  )
}
