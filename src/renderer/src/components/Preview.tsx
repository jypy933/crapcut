import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from 'react'
import { captionAt, clipWords, displayText, groupWords, isKeywordWord } from '@shared/captions'
import { captionStyle } from '@shared/captionStyles'
import type { RenderFormat } from '@shared/layoutGeometry'
import type { Clip, Layout } from '@shared/types'
import { drawFrame } from '../lib/compose'
import { Spinner } from './ui'

interface Props {
  clip: Clip
  src: string
  layout: Layout
  format: RenderFormat
  videoRef: RefObject<HTMLVideoElement | null>
  /** VOD time of the playhead. */
  time: number
  onTime: (t: number) => void
  onPlaying: (p: boolean) => void
  onCaptionY: (y: number) => void
}

export function Preview({ clip, src, layout, format, videoRef, time, onTime, onPlaying, onCaptionY }: Props): ReactNode {
  const box = useRef<HTMLDivElement>(null)
  const canvas = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ w: 0, h: 0 })
  const [ready, setReady] = useState(false)
  const [dragY, setDragY] = useState<number | null>(null)
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

  // Draw loop: every animation frame while playing, once after seeks.
  useEffect(() => {
    const v = videoRef.current
    const c = canvas.current
    if (!v || !c) return
    const ctx = c.getContext('2d')
    if (!ctx) return
    let raf = 0
    const draw = (): void => {
      drawFrame(ctx, v, layout, format)
      const t = sourceStart + v.currentTime
      if (!v.paused && t >= clip.end) {
        v.currentTime = Math.max(0, clip.start - sourceStart)
      }
      onTime(t)
    }
    const loop = (): void => {
      draw()
      raf = requestAnimationFrame(loop)
    }
    const onPlay = (): void => {
      onPlaying(true)
      cancelAnimationFrame(raf)
      loop()
    }
    const onPause = (): void => {
      onPlaying(false)
      cancelAnimationFrame(raf)
      draw()
    }
    const onReady = (): void => {
      setReady(true)
      draw()
    }
    v.addEventListener('play', onPlay)
    v.addEventListener('pause', onPause)
    v.addEventListener('seeked', draw)
    v.addEventListener('loadeddata', onReady)
    if (v.readyState >= 2) onReady()
    if (!v.paused) onPlay()
    return () => {
      cancelAnimationFrame(raf)
      v.removeEventListener('play', onPlay)
      v.removeEventListener('pause', onPause)
      v.removeEventListener('seeked', draw)
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
  const y = dragY ?? (format === 'vertical' ? clip.captions.y : Math.max(0.6, Math.min(0.92, clip.captions.y + 0.1)))
  const fontPx = size.h * (format === 'vertical' ? 88 / 1920 : 72 / 1080)
  const strokePx = style.box ? 0 : size.h * (format === 'vertical' ? (7 * 2) / 1920 : (6 * 2) / 1080) * style.outlineScale

  function startDrag(e: React.PointerEvent): void {
    if (format !== 'vertical') return
    const frame = (e.currentTarget as HTMLElement).parentElement!
    const rect = frame.getBoundingClientRect()
    ;(e.currentTarget as HTMLElement).setPointerCapture(e.pointerId)
    const move = (ev: PointerEvent): void => setDragY(Math.max(0.08, Math.min(0.92, (ev.clientY - rect.top) / rect.height)))
    const up = (ev: PointerEvent): void => {
      window.removeEventListener('pointermove', move)
      window.removeEventListener('pointerup', up)
      const finalY = Math.max(0.08, Math.min(0.92, (ev.clientY - rect.top) / rect.height))
      setDragY(null)
      onCaptionY(Math.round(finalY * 1000) / 1000)
    }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', up)
  }

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
        {dragY !== null && <div className="cap-guide" style={{ top: `${dragY * 100}%` }} />}
        {clip.captions.enabled && now && (
          <div
            className={`cap${style.box ? ' boxed' : ''}`}
            style={{
              top: `${y * 100}%`,
              fontSize: fontPx,
              fontFamily: style.cssFontFamily,
              color: style.textColor,
              WebkitTextStrokeWidth: strokePx,
              cursor: format === 'vertical' ? 'ns-resize' : 'default'
            }}
            onPointerDown={startDrag}
            title={format === 'vertical' ? 'Drag to move the captions' : undefined}
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
      </div>
    </div>
  )
}
