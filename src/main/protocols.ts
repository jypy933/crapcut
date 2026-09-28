// Custom protocols:
//   app://bundle/...                 the UI's own files (instead of file://)
//   crapcut-media://clip/<job>/<id>  a clip's downloaded video, with Range
//                                    support so the review player can seek.

import { createReadStream, existsSync, statSync } from 'node:fs'
import { extname, join, normalize, relative, isAbsolute } from 'node:path'
import { Readable } from 'node:stream'
import { protocol } from 'electron'
import { jobDir, type AppPaths } from './paths'

export function registerSchemes(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: 'app', privileges: { standard: true, secure: true, supportFetchAPI: true } },
    { scheme: 'crapcut-media', privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true } }
  ])
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.json': 'application/json'
}

/** Resolves a request path inside root, or null if it tries to escape. */
export function resolveInside(root: string, requestPath: string): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(requestPath)
  } catch {
    return null
  }
  if (decoded.includes('\0')) return null
  const target = normalize(join(root, decoded))
  const rel = relative(root, target)
  if (rel.startsWith('..') || isAbsolute(rel)) return null
  return target
}

/** Parses a single "bytes=a-b" range against a file size. */
export function parseRange(header: string | null, size: number): { start: number; end: number } | null {
  if (!header) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim())
  if (!m || (!m[1] && !m[2])) return null
  let start: number
  let end: number
  if (!m[1]) {
    const suffix = Number(m[2])
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] ? Math.min(Number(m[2]), size - 1) : size - 1
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) return null
  return { start, end }
}

function fileResponse(file: string, range: string | null, type: string): Response {
  const size = statSync(file).size
  const r = parseRange(range, size)
  const headers: Record<string, string> = { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store' }
  if (!r) {
    headers['Content-Length'] = String(size)
    return new Response(Readable.toWeb(createReadStream(file)) as ReadableStream, { status: 200, headers })
  }
  headers['Content-Length'] = String(r.end - r.start + 1)
  headers['Content-Range'] = `bytes ${r.start}-${r.end}/${size}`
  return new Response(Readable.toWeb(createReadStream(file, { start: r.start, end: r.end })) as ReadableStream, { status: 206, headers })
}

const ID = /^[a-z0-9-]{6,64}$/i

export function handleProtocols(paths: AppPaths, rendererDir: string): void {
  protocol.handle('app', (request) => {
    const url = new URL(request.url)
    if (url.host !== 'bundle') return new Response('not found', { status: 404 })
    const file = resolveInside(rendererDir, url.pathname === '/' ? '/index.html' : url.pathname)
    if (!file || !existsSync(file) || statSync(file).isDirectory()) return new Response('not found', { status: 404 })
    return fileResponse(file, null, MIME[extname(file).toLowerCase()] ?? 'application/octet-stream')
  })

  protocol.handle('crapcut-media', (request) => {
    const url = new URL(request.url)
    const parts = url.pathname.split('/').filter(Boolean)
    if (url.host !== 'clip' || parts.length !== 2 || !parts.every((p) => ID.test(p))) return new Response('not found', { status: 404 })
    const file = join(jobDir(paths, parts[0]!), 'clips', `${parts[1]}.mp4`)
    if (!existsSync(file)) return new Response('not found', { status: 404 })
    return fileResponse(file, request.headers.get('range'), 'video/mp4')
  })
}
