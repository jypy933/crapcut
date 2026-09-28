import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({ protocol: {}, app: {}, session: {}, shell: {} }))

const { parseRange, resolveInside } = await import('./protocols')

describe('parseRange', () => {
  it('parses normal, open and suffix ranges', () => {
    expect(parseRange('bytes=0-99', 1000)).toEqual({ start: 0, end: 99 })
    expect(parseRange('bytes=500-', 1000)).toEqual({ start: 500, end: 999 })
    expect(parseRange('bytes=-100', 1000)).toEqual({ start: 900, end: 999 })
    expect(parseRange('bytes=900-5000', 1000)).toEqual({ start: 900, end: 999 })
  })
  it('rejects junk and unsatisfiable ranges', () => {
    expect(parseRange(null, 1000)).toBeNull()
    expect(parseRange('bytes=-', 1000)).toBeNull()
    expect(parseRange('bytes=2000-', 1000)).toBeNull()
    expect(parseRange('bytes=5-1', 1000)).toBeNull()
    expect(parseRange('items=0-1', 1000)).toBeNull()
    expect(parseRange('bytes=0-1,5-9', 1000)).toBeNull()
  })
})

describe('resolveInside', () => {
  const root = join('C:', 'app', 'renderer')
  it('keeps requests inside the root', () => {
    expect(resolveInside(root, '/index.html')).toBe(join(root, 'index.html'))
    expect(resolveInside(root, '/assets/a.js')).toBe(join(root, 'assets', 'a.js'))
  })
  it('refuses traversal', () => {
    expect(resolveInside(root, '/../secret.txt')).toBeNull()
    expect(resolveInside(root, '/%2e%2e/%2e%2e/secret')).toBeNull()
    expect(resolveInside(root, '/..%5c..%5csecret')).toBeNull()
    expect(resolveInside(root, '/%E0%A4%A')).toBeNull()
    expect(resolveInside(root, '/a%00b')).toBeNull()
  })
})

describe('security helpers', () => {
  it('recognises app urls', async () => {
    const sec = await import('./security')
    expect(sec.isAppUrl('app://bundle/index.html', undefined)).toBe(true)
    expect(sec.isAppUrl('https://evil.com', undefined)).toBe(false)
    expect(sec.isAppUrl('http://localhost:5173/x', 'http://localhost:5173')).toBe(true)
    expect(sec.isAppUrl('http://localhost:5174/x', 'http://localhost:5173')).toBe(false)
  })
  it('only opens listed external links', async () => {
    const sec = await import('./security')
    const allowed = new Set(['https://github.com/jypy933/crapcut'])
    expect(sec.isAllowedExternal('https://github.com/jypy933/crapcut', allowed)).toBe(true)
    expect(sec.isAllowedExternal('https://github.com/other', allowed)).toBe(false)
    expect(sec.isAllowedExternal('file:///C:/Windows/system32/calc.exe', allowed)).toBe(false)
  })
})
