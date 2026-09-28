import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { crc32 } from 'node:zlib'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { UserError } from '../util/errors'
import { downloadVerified } from './download'
import { extractZip, safeEntryPath } from './extract'
import { isAllowedDownloadUrl } from './manifest'

const payload = Buffer.from(Array.from({ length: 200_000 }, (_, i) => i % 251))
const sha = createHash('sha256').update(payload).digest('hex')

let server: Server
let base = ''
let dir = ''
let requests: { url: string; range: string | undefined }[] = []

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'crapcut-dl-'))
  server = createServer((req, res) => {
    requests.push({ url: req.url ?? '', range: req.headers.range })
    if (req.url === '/redirect-away') {
      res.writeHead(302, { Location: 'http://127.0.0.2:1/elsewhere' })
      return res.end()
    }
    const m = /bytes=(\d+)-/.exec(req.headers.range ?? '')
    if (m && req.url !== '/no-range') {
      const start = Number(m[1])
      res.writeHead(206, { 'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`, 'Content-Length': payload.length - start })
      return res.end(payload.subarray(start))
    }
    res.writeHead(200, { 'Content-Length': payload.length })
    res.end(payload)
  })
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
})

afterAll(() => {
  server.close()
  rmSync(dir, { recursive: true, force: true })
})

const allowLocal = (u: string): boolean => u.startsWith('http://127.0.0.1:')

describe('downloadVerified', () => {
  it('downloads and verifies', async () => {
    const dest = join(dir, 'a.bin')
    let last = 0
    await downloadVerified({ url: `${base}/a`, dest, sha256: sha, size: payload.length, allowUrl: allowLocal, onProgress: (b) => (last = b) })
    expect(readFileSync(dest).equals(payload)).toBe(true)
    expect(last).toBe(payload.length)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('resumes a partial download with a Range request', async () => {
    const dest = join(dir, 'b.bin')
    writeFileSync(`${dest}.part`, payload.subarray(0, 50_000))
    requests = []
    await downloadVerified({ url: `${base}/b`, dest, sha256: sha, size: payload.length, allowUrl: allowLocal })
    expect(requests[0]!.range).toBe('bytes=50000-')
    expect(readFileSync(dest).equals(payload)).toBe(true)
  })

  it('restarts when the server ignores the range', async () => {
    const dest = join(dir, 'c.bin')
    writeFileSync(`${dest}.part`, Buffer.alloc(1000, 7))
    await downloadVerified({ url: `${base}/no-range`, dest, sha256: sha, size: payload.length, allowUrl: allowLocal })
    expect(readFileSync(dest).equals(payload)).toBe(true)
  })

  it('deletes a file with the wrong checksum', async () => {
    const dest = join(dir, 'd.bin')
    await expect(downloadVerified({ url: `${base}/d`, dest, sha256: '0'.repeat(64), size: payload.length, allowUrl: allowLocal })).rejects.toBeInstanceOf(UserError)
    expect(existsSync(dest)).toBe(false)
    expect(existsSync(`${dest}.part`)).toBe(false)
  })

  it('refuses unexpected sizes, links and redirects', async () => {
    await expect(downloadVerified({ url: `${base}/e`, dest: join(dir, 'e.bin'), sha256: sha, size: 10, allowUrl: allowLocal })).rejects.toThrow()
    await expect(downloadVerified({ url: `${base}/f`, dest: join(dir, 'f.bin'), sha256: sha, size: payload.length })).rejects.toMatchObject({ userMessage: expect.stringMatching(/not allowed/) })
    await expect(
      downloadVerified({ url: `${base}/redirect-away`, dest: join(dir, 'g.bin'), sha256: sha, size: payload.length, allowUrl: allowLocal })
    ).rejects.toBeInstanceOf(UserError)
  })

  it('can be cancelled', async () => {
    const ac = new AbortController()
    ac.abort()
    await expect(downloadVerified({ url: `${base}/h`, dest: join(dir, 'h.bin'), sha256: sha, size: payload.length, allowUrl: allowLocal, signal: ac.signal })).rejects.toThrow(
      'cancelled'
    )
  })
})

describe('isAllowedDownloadUrl', () => {
  it('only allows HTTPS from known hosts', () => {
    expect(isAllowedDownloadUrl('https://github.com/x/y/releases/download/1/a.zip')).toBe(true)
    expect(isAllowedDownloadUrl('https://cas-bridge.xethub.hf.co/x')).toBe(true)
    expect(isAllowedDownloadUrl('http://github.com/x')).toBe(false)
    expect(isAllowedDownloadUrl('https://github.com.evil.io/x')).toBe(false)
    expect(isAllowedDownloadUrl('https://user@github.com/x')).toBe(false)
    expect(isAllowedDownloadUrl('nonsense')).toBe(false)
  })
})

/** Minimal "stored" zip writer for tests. */
function makeZip(entries: { name: string; data: Buffer }[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const e of entries) {
    const name = Buffer.from(e.name, 'utf8')
    const crc = crc32(e.data)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0x0800, 6)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(e.data.length, 18)
    local.writeUInt32LE(e.data.length, 22)
    local.writeUInt16LE(name.length, 26)
    locals.push(local, name, e.data)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(0x0800, 8)
    central.writeUInt32LE(crc, 16)
    central.writeUInt32LE(e.data.length, 20)
    central.writeUInt32LE(e.data.length, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt32LE(offset, 42)
    centrals.push(central, name)
    offset += 30 + name.length + e.data.length
  }
  const cd = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(cd.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, cd, end])
}

describe('extractZip', () => {
  it('extracts only matching files', async () => {
    const zip = join(dir, 'ok.zip')
    writeFileSync(
      zip,
      makeZip([
        { name: 'pkg/bin/tool.exe', data: Buffer.from('exe') },
        { name: 'pkg/doc/readme.html', data: Buffer.from('doc') }
      ])
    )
    const out = join(dir, 'ok')
    const files = await extractZip(zip, out, { include: /\/bin\// })
    expect(files).toHaveLength(1)
    expect(readFileSync(join(out, 'pkg', 'bin', 'tool.exe'), 'utf8')).toBe('exe')
    expect(existsSync(join(out, 'pkg', 'doc'))).toBe(false)
  })

  it('refuses entries that escape the folder', async () => {
    const zip = join(dir, 'evil.zip')
    writeFileSync(zip, makeZip([{ name: '../evil.txt', data: Buffer.from('x') }]))
    await expect(extractZip(zip, join(dir, 'evil'))).rejects.toThrow()
    expect(existsSync(join(dir, 'evil.txt'))).toBe(false)
  })

  it('validates entry paths', () => {
    const root = join(dir, 'root')
    expect(safeEntryPath(root, 'a/b.txt')).toBe(join(root, 'a', 'b.txt'))
    expect(safeEntryPath(root, '../x')).toBeNull()
    expect(safeEntryPath(root, 'a/../../x')).toBeNull()
    expect(safeEntryPath(root, 'C:/Windows/x')).toBeNull()
    expect(safeEntryPath(root, '/etc/passwd')).toBeNull()
    expect(safeEntryPath(root, 'a\\..\\..\\x')).toBeNull()
    expect(safeEntryPath(root, 'file.txt:hidden')).toBeNull()
    expect(safeEntryPath(root, 'bin/NUL.txt')).toBeNull()
    expect(safeEntryPath(root, 'bin/console.exe')).toBe(join(root, 'bin', 'console.exe'))
  })
})
