// Downloads a pinned file with resume, progress and SHA-256 verification.

import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, renameSync, rmSync, statSync } from 'node:fs'
import { once } from 'node:events'
import { CancelledError, UserError, throwIfAborted } from '../util/errors'
import { isAllowedDownloadUrl } from './manifest'

export type FetchLike = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal; redirect?: 'follow' }) => Promise<Response>

export interface DownloadOptions {
  url: string
  dest: string
  sha256: string
  size: number
  signal?: AbortSignal
  fetch?: FetchLike
  /** Called with bytes downloaded so far (including a resumed part). */
  onProgress?: (bytes: number) => void
  onVerifying?: () => void
  /** Which URLs may be fetched (tests use a local server). */
  allowUrl?: (url: string) => boolean
}

export async function sha256File(file: string, signal?: AbortSignal): Promise<string> {
  const hash = createHash('sha256')
  const stream = createReadStream(file, { highWaterMark: 4 * 1024 * 1024 })
  for await (const chunk of stream) {
    if (signal?.aborted) {
      stream.destroy()
      throw new CancelledError()
    }
    hash.update(chunk as Buffer)
  }
  return hash.digest('hex')
}

/**
 * Downloads `url` to `dest`. A partial `dest.part` from an earlier attempt is
 * resumed with an HTTP Range request. The file only appears at `dest` once its
 * SHA-256 matches.
 */
export async function downloadVerified(opts: DownloadOptions): Promise<void> {
  const { url, dest, sha256, size, signal } = opts
  const doFetch: FetchLike = opts.fetch ?? ((u, init) => fetch(u, init))
  const allowed = opts.allowUrl ?? isAllowedDownloadUrl
  if (!allowed(url)) throw new UserError('A download link in CrapCut is not allowed.', { retryable: false, detail: url })

  const part = `${dest}.part`
  let have = existsSync(part) ? statSync(part).size : 0
  if (have > size) {
    rmSync(part, { force: true })
    have = 0
  }

  if (have < size) {
    throwIfAborted(signal)
    const headers: Record<string, string> = { 'User-Agent': 'CrapCut' }
    if (have > 0) headers.Range = `bytes=${have}-`
    let res: Response
    try {
      res = await doFetch(url, { headers, signal, redirect: 'follow' })
    } catch (err) {
      if (signal?.aborted) throw new CancelledError()
      throw new UserError('Could not reach the download server. Check your internet connection.', { cause: err })
    }
    if (res.url && !allowed(res.url)) {
      throw new UserError('A download was redirected somewhere unexpected, so it was stopped.', { retryable: false, detail: res.url })
    }
    if (res.status === 416 && have > 0) {
      // Server says the range is past the end: start over.
      rmSync(part, { force: true })
      return downloadVerified(opts)
    }
    if (!res.ok || !res.body) throw new UserError('The download server did not answer properly. Try again later.', { detail: `HTTP ${res.status} for ${url}` })
    const append = res.status === 206 && have > 0
    if (!append) have = 0

    const out = createWriteStream(part, { flags: append ? 'a' : 'w' })
    let received = have
    let lastReport = 0
    try {
      const reader = res.body.getReader()
      for (;;) {
        if (signal?.aborted) {
          await reader.cancel().catch(() => {})
          throw new CancelledError()
        }
        const { done, value } = await reader.read()
        if (done) break
        received += value.byteLength
        if (received > size) throw new UserError('A download was larger than expected, so it was stopped.', { detail: url })
        if (!out.write(value)) await once(out, 'drain')
        const now = Date.now()
        if (now - lastReport > 250) {
          lastReport = now
          opts.onProgress?.(received)
        }
      }
    } catch (err) {
      out.destroy()
      if (err instanceof UserError || err instanceof CancelledError) throw err
      if (signal?.aborted) throw new CancelledError()
      throw new UserError('The download was interrupted. It will continue where it stopped.', { cause: err })
    }
    out.end()
    await once(out, 'close')
    opts.onProgress?.(received)
    if (received !== size) throw new UserError('The download was interrupted. It will continue where it stopped.', { detail: `got ${received} of ${size}` })
  }

  opts.onVerifying?.()
  const actual = await sha256File(part, signal)
  if (actual !== sha256.toLowerCase()) {
    rmSync(part, { force: true })
    throw new UserError('A downloaded file was damaged or changed, so it was deleted. Try again.', {
      detail: `sha256 mismatch for ${url}: expected ${sha256}, got ${actual}`
    })
  }
  rmSync(dest, { force: true })
  renameSync(part, dest)
}
