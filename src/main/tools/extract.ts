// Extracts a zip safely: no paths outside the target folder, no symlinks,
// optional filter so only the files we need are written.

import { createWriteStream, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, normalize, relative, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'
import { CancelledError } from '../util/errors'

/** Returns the safe destination for an entry, or null if it would escape. */
export function safeEntryPath(root: string, entryName: string): string | null {
  const name = entryName.replace(/\\/g, '/')
  if (!name || name.includes('\0') || isAbsolute(name) || /^[a-zA-Z]:/.test(name)) return null
  const target = normalize(join(root, name))
  const rel = relative(root, target)
  if (!rel || rel.startsWith('..') || isAbsolute(rel) || rel.split(sep).includes('..')) return null
  return target
}

export interface ExtractOptions {
  include?: RegExp
  signal?: AbortSignal
  /** Stop if the archive would write more than this many bytes. */
  maxBytes?: number
}

export async function extractZip(zipFile: string, destDir: string, opts: ExtractOptions = {}): Promise<string[]> {
  const maxBytes = opts.maxBytes ?? 4 * 1024 * 1024 * 1024
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) =>
    yauzl.open(zipFile, { lazyEntries: true, autoClose: true, strictFileNames: false, validateEntrySizes: true }, (err, z) =>
      err || !z ? reject(err ?? new Error('zip open failed')) : resolve(z)
    )
  )
  mkdirSync(destDir, { recursive: true })
  const written: string[] = []
  let total = 0

  return new Promise<string[]>((resolve, reject) => {
    const fail = (err: unknown): void => {
      zip.close()
      reject(err)
    }
    zip.on('error', fail)
    zip.on('end', () => resolve(written))
    zip.on('entry', (entry: yauzl.Entry) => {
      if (opts.signal?.aborted) return fail(new CancelledError())
      const name = entry.fileName
      const isDir = name.endsWith('/')
      // Unix mode bits in the upper 16 bits; 0o120000 is a symlink.
      const mode = (entry.externalFileAttributes >>> 16) & 0o170000
      if (isDir || mode === 0o120000 || (opts.include && !opts.include.test(name))) {
        zip.readEntry()
        return
      }
      const target = safeEntryPath(destDir, name)
      if (!target) return fail(new Error(`unsafe zip entry: ${name}`))
      total += entry.uncompressedSize
      if (total > maxBytes) return fail(new Error('zip is larger than allowed'))
      zip.openReadStream(entry, (err, stream) => {
        if (err || !stream) return fail(err ?? new Error('zip read failed'))
        mkdirSync(dirname(target), { recursive: true })
        pipeline(stream, createWriteStream(target))
          .then(() => {
            written.push(target)
            zip.readEntry()
          })
          .catch(fail)
      })
    })
    zip.readEntry()
  })
}
