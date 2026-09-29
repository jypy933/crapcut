import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { captionAt, clipWords, displayText, groupWords, isKeywordWord } from '@shared/captions'
import { captionY, placeCaptionY, resetCaptionY, withCaptionY } from '@shared/captionPlacement'
import { captionStyle } from '@shared/captionStyles'
import {
  buildChatOverlay,
  chatBoxNorm,
  chatOverlayGeometry,
  chatPosition,
  DEFAULT_CHAT_OVERLAY_OPTIONS,
  placeChatBox,
  resetChatPosition,
  withChatPosition
} from '@shared/chatOverlay'
import { OUTPUT_SIZE, type RenderFormat } from '@shared/layoutGeometry'
import { pointerToNorm, safeArea, type FormatPositions, type NormPos } from '@shared/overlayPosition'
import type { CaptionSettings, Clip, Layout } from '@shared/types'
import { drawFrame } from '../lib/compose'
import { Spinner } from './ui'

/** How often the parent hears about the playhead while playing. */
const REPORT_MS = 100

interface Props {
  clip: Clip
  src: string
  layout: Layout
  format: RenderFormat
  videoRef: RefObject<HTMLVideoElement | null>
  /** Reports the playhead's VOD time, throttled while playing. */
  onTime: (t: number) => void
  onPlaying: (p: boolean) => void
  /** He moved (or reset) the captions; the settings to save. */
  onCaptions: (captions: CaptionSettings) => void
  /** He moved (or reset) the chat box; the positions to save. */
  onChatPos: (pos: FormatPositions) => void
}

/** What is being dragged, with the frame lines it is currently snapped to (for the guides). */
type Drag = { kind: 'caption'; y: number; guide: number | null } | { kind: 'chat'; pos: NormPos; guideX: number | null; guideY: number | null }

export function Preview({ clip, src, layout, format, videoRef, onTime, onPlaying, onCaptions, onChatPos }: Props): ReactNode {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [ready, setReady] = useState(false)
  const [drag, setDrag] = useState<Drag | null>(null)
  // The playhead, updated every drawn frame. Only this component follows it
  // that closely; the parent gets a throttled copy so the whole Review screen
  // does not re-render at the display's refresh rate.
  const [time, setTime] = useState(0)
  // The clip's own source video, for facecam geometry; a plausible guess until it loads.
  const [naturalSize, setNaturalSize] = useState({ width: 1920, height: 1080 })
  const aspect = format === 'vertical' ? 9 / 16 : 16 / 9
  const sourceStart = clip.source?.start ?? 0

  // Fit the frame into the available space.
  useLayoutEffect(() => {
    const el = box.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const { width, height } = el.getBoundingClientRect()
      let w = width
      let h = w / aspect
      if (h > height) {
        h = height
        w = h * aspect
      }
      setSize({ w: Math.floor(w), h: Math.floor(h) })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [aspect])

  // Draw loop: once per decoded video frame while playing, once after seeks.
  useEffect(() => {
    const v = videoRef.current
    const c = canvas.current
    if (!v || !c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    let frame = 0
    let lastReport = 0
    const report = (t: number, force: boolean): void => {
      setTime(t)
      const now = performance.now()
      if (force || now - lastReport >= REPORT_MS) {
        lastReport = now
        onTime(t)
      }
    }
    const draw = (force: boolean): void => {
      drawFrame(ctx, v, layout, format)
      const t = sourceStart + v.currentTime
      if (!v.paused && t >= clip.end) {
        v.currentTime = Math.max(0, clip.start - sourceStart)
      }
      report(t, force)
    }
    // requestVideoFrameCallback fires once per new video frame (30 fps video
    // on a 60+ Hz display draws half as often as requestAnimationFrame).
    const hasVfc = typeof v.requestVideoFrameCallback === 'function'
    const cancel = (): void => {
      if (hasVfc) v.cancelVideoFrameCallback(frame)
      else cancelAnimationFrame(frame)
    }
    const loop = (): void => {
      draw(false)
      frame = hasVfc ? v.requestVideoFrameCallback(loop) : requestAnimationFrame(loop)
    }
    const onPlay = (): void => {
      onPlaying(true)
      cancel()
      loop()
    }
    const onPause = (): void => {
      onPlaying(false)
      cancel()
      draw(true)
    }
    const onSeeked = (): void => draw(true)
    const onReady = (): void => {
      setReady(true)
      if (v.videoWidth && v.videoHeight) setNaturalSize({ width: v.videoWidth, height: v.videoHeight })
      draw(true)
    }
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('seeked', onSeeked)
    v.addEventListener('loadeddata', onReady)
    if (v.readyState >= 2) onReady()
    if (!v.paused) onPlay()
    return () => {
      cancel()
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('seeked', onSeeked)
      v.removeEventListener('loadeddata', onReady)
    }
  }, [videoRef, layout, format, clip.start, clip.end, sourceStart, onTime, onPlaying, size])

  // Start at the clip's in-point when a new clip loads.
  useEffect(() => {
    setReady(false)
    const v = videoRef.current
    if (!v) return
    const seek = (): void => {
      v.currentTime = Math.max(0, clip.start - sourceStart)
    }
    if (v.readyState >= 1) seek()
    else v.addEventListener('loadedmetadata', seek, { once: true })
    // Only when the clip itself changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clip.id, src])

  const groups = useMemo(() => groupWords(clipWords(clip.words, clip.start, clip.end)), [clip.words, clip.start, clip.end])
  const now = captionAt(groups, time - clip.start)
  const style = useMemo(() => captionStyle(clip.captions.styleId), [clip.captions.styleId])
  // The caption's height comes from the same pure mapping the ASS export uses.
  const y = drag?.kind === 'caption' ? drag.y : captionY(clip.captions, format)
  const fontPx = size.h * (format === 'vertical' ? 88 / 1920 : 72 / 1080)
  const strokePx = style.box ? 0 : size.h * (format === 'vertical' ? (7 * 2) / 1920 : (6 * 2) / 1080) * style.outlineScale

  // Chat overlay: an approximation of the burned-in look, same placement logic.
  // A clip saved before the chat overlay existed has neither field yet (main
  // normalises on read, but this stays cheap insurance).
  const chatMessages = clip.chatMessages ?? []
  const out = OUTPUT_SIZE[format]
  const chatOn = (clip.chatOverlay ?? false) && chatMessages.length > 0
  const captionYForChat = clip.captions.enabled ? y : null
  const chatPos = drag?.kind === 'chat' ? drag.pos : chatPosition(clip.chatPos, format)
  // Its default place (also the snap target), and the size it keeps once he has placed it.
  const chatHome = useMemo(() => chatBoxNorm(chatOverlayGeometry(format, layout, naturalSize, captionYForChat), format), [format, layout, naturalSize, captionYForChat])
  const chatFree = useMemo(
    () => chatBoxNorm(chatOverlayGeometry(format, layout, naturalSize, null, DEFAULT_CHAT_OVERLAY_OPTIONS, { x: 0, y: 0 }), format),
    [format, layout, naturalSize]
  )
  const chatGeometry = useMemo(
    () => (chatOn ? chatOverlayGeometry(format, layout, naturalSize, captionYForChat, DEFAULT_CHAT_OVERLAY_OPTIONS, chatPos) : null),
    // chatPos is a fresh object each render; its two numbers are what matter.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatOn, format, layout, naturalSize, captionYForChat, chatPos?.x, chatPos?.y]
  )
  const chatLines = useMemo(
    () => (chatGeometry ? buildChatOverlay(chatMessages, clip.start, clip.end, chatGeometry) : []),
    [chatGeometry, chatMessages, clip.start, clip.end]
  )
  const chatNow = time - clip.start
  const activeChat = chatLines.filter((l) => chatNow >= l.start && chatNow < l.end)
  const chatFontPx = size.h * (DEFAULT_CHAT_OVERLAY_OPTIONS.fontSize / out.height)

  // Dragging: the pointer's movement over the frame, as fractions of it, moves
  // an overlay from where it started; the shared placement rules limit and
  // snap it (hold Alt to move freely), and the result is what gets saved and
  // exported. A click without movement saves nothing.
  function startDrag(e: React.PointerEvent, move: (dx: number, dy: number, free: boolean) => Drag, commit: (d: Drag) => void): void {
    if (e.button !== 0) return
    const target = e.currentTarget as HTMLElement
    const frame = target.parentElement!.getBoundingClientRect()
    const from = pointerToNorm(e.clientX, e.clientY, frame)
    target.setPointerCapture(e.pointerId)
    let last: Drag | null = null
    const onMove = (ev: PointerEvent): void => {
      const p = pointerToNorm(ev.clientX, ev.clientY, frame)
      last = move(p.x - from.x, p.y - from.y, ev.altKey)
      setDrag(last)
    }
    const onUp = (): void => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      window.removeEventListener('pointercancel', onUp)
      setDrag(null)
      if (last) commit(last)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
    window.addEventListener('pointercancel', onUp)
  }

  function dragCaption(e: React.PointerEvent): void {
    startDrag(
      e,
      (_dx, dy, free) => ({ kind: 'caption', ...placeCaptionY(y + dy, format, { snap: !free, verticalY: clip.captions.y }) }),
      (d) => {
        if (d.kind === 'caption') onCaptions(withCaptionY(clip.captions, format, d.y))
      }
    )
  }

  function dragChat(e: React.PointerEvent): void {
    if (!chatGeometry) return
    const at = chatBoxNorm(chatGeometry, format)
    startDrag(
      e,
      (dx, dy, free) => ({ kind: 'chat', ...placeChatBox({ x: at.x + dx, y: at.y + dy }, chatFree, format, chatHome, { snap: !free }) }),
      (d) => {
        if (d.kind === 'chat') onChatPos(withChatPosition(clip.chatPos, format, d.pos))
      }
    )
  }

  // While dragging: what the short-video apps cover, and the line the overlay is snapped to.
  const covered = drag ? safeArea(format).covered : []
  const guideY = drag?.kind === 'caption' ? drag.guide : drag?.kind === 'chat' ? drag.guideY : null
  const guideX = drag?.kind === 'chat' ? drag.guideX : null

  return (
    <div className="viewport" ref={box}>
      <video ref={videoRef} src={src} preload="auto" hidden playsInline />
      <div className="frame" style={{ width: size.w, height: size.h }}>
        <canvas ref={canvas} width={Math.max(2, Math.round(size.w * devicePixelRatio))} height={Math.max(2, Math.round(size.h * devicePixelRatio))} />
        {!ready && (
          <div className="loading">
            <Spinner size={18} />
          </div>
        )}
        {covered.map((r, i) => (
          <div
            key={i}
            className="safe-zone"
            style={{ left: `${r.x * 100}%`, top: `${r.y * 100}%`, width: `${r.w * 100}%`, height: `${r.h * 100}%` }}
          />
        ))}
        {guideY !== null && <div className="snap-guide h" style={{ top: `${guideY * 100}%` }} />}
        {guideX !== null && <div className="snap-guide v" style={{ left: `${guideX * 100}%` }} />}
        {clip.captions.enabled && now && (
          <div
            className={`cap${style.box ? ' boxed' : ''}${drag?.kind === 'caption' ? ' dragging' : ''}`}
            style={{
              top: `${y * 100}%`,
              fontSize: fontPx,
              fontFamily: style.cssFontFamily,
              color: style.textColor,
              WebkitTextStrokeWidth: strokePx
            }}
            onPointerDown={dragCaption}
            onDoubleClick={() => onCaptions(resetCaptionY(clip.captions, format))}
            title="Drag to move the captions, double-click to reset"
          >
            {now.group.words.map((w, i) => {
              const active = i === now.active
              const emphasised = active || (style.emphasizeKeywords && isKeywordWord(w.text))
              return (
                <span
                  key={`${w.t0}-${i}`}
                  className={active && style.pop ? 'pop' : undefined}
                  style={emphasised ? { color: style.highlightColor } : undefined}
                >
                  {displayText(w.text, clip.captions.uppercase)}
                  {i < now.group.words.length - 1 ? ' ' : ''}
                </span>
              )
            })}
          </div>
        )}
        {chatGeometry && (
          <div
            className={`chat-box${drag?.kind === 'chat' ? ' dragging' : ''}`}
            style={{
              top: `${(chatGeometry.y / out.height) * 100}%`,
              left: `${(chatGeometry.x / out.width) * 100}%`,
              width: `${(chatGeometry.w / out.width) * 100}%`,
              height: `${(chatGeometry.h / out.height) * 100}%`
            }}
            onPointerDown={dragChat}
            onDoubleClick={() => onChatPos(resetChatPosition(clip.chatPos, format))}
            title="Drag to move the chat, double-click to reset"
          >
            {activeChat.map((l, i) => (
              <div
                key={`${l.user}-${l.start}-${i}`}
                className={`chat-line${l.align === 'right' ? ' right' : ''}`}
                style={{
                  top: `${((l.y - chatGeometry.y) / chatGeometry.h) * 100}%`,
                  textAlign: l.align,
                  fontSize: chatFontPx
                }}
              >
                <span className="chat-user" style={{ color: l.color }}>
                  {l.user}
                </span>
                : {l.messageLines.join(' ')}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
