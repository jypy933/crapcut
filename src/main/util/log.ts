// A small file logger. The log lives next to the app data so the user can send
// it when something breaks. Home folder paths are replaced with "~" so the
// user's name does not end up in it.

import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import { join } from 'node:path'

const MAX_BYTES = 5 * 1024 * 1024
const KEEP = 3

let logDir: string | null = null
let logFile: string | null = null

export function initLog(dir: string): void {
  mkdirSync(dir, { recursive: true })
  logDir = dir
  logFile = join(dir, 'crapcut.log')
}

export function logFolder(): string | null {
  return logDir
}

export function logFilePath(): string | null {
  return logFile
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const redactions: RegExp[] = (() => {
  const out: RegExp[] = []
  const home = homedir()
  if (home) {
    out.push(new RegExp(escapeRegExp(home), 'gi'))
    out.push(new RegExp(escapeRegExp(home.replace(/\\/g, '/')), 'gi'))
    out.push(new RegExp(escapeRegExp(home.replace(/\\/g, '\\\\')), 'gi'))
  }
  return out
})()

const username = (() => {
  try {
    return userInfo().username
  } catch {
    return ''
  }
})()

/** Removes the home folder and user name from a log line. */
export function redact(text: string): string {
  let out = text
  for (const r of redactions) out = out.replace(r, '~')
  if (username.length >= 3) out = out.replace(new RegExp(`(^|[^\\p{L}\\p{N}])${escapeRegExp(username)}(?=$|[^\\p{L}\\p{N}])`, 'giu'), '$1<user>')
  return out
}

function rotate(file: string): void {
  try {
    if (!existsSync(file) || statSync(file).size < MAX_BYTES) return
    rmSync(`${file}.${KEEP}`, { force: true })
    for (let i = KEEP - 1; i >= 1; i--) if (existsSync(`${file}.${i}`)) renameSync(`${file}.${i}`, `${file}.${i + 1}`)
    renameSync(file, `${file}.1`)
  } catch {
    // Never let logging break the app.
  }
}

function format(value: unknown): string {
  if (value instanceof Error) {
    const cause = value.cause ? ` (cause: ${format(value.cause)})` : ''
    const stack = value.stack ? `\n${value.stack.split('\n').slice(1, 6).join('\n')}` : ''
    return `${value.name}: ${value.message}${cause}${stack}`
  }
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function write(level: string, scope: string, parts: unknown[]): void {
  const line = redact(`${new Date().toISOString()} ${level} [${scope}] ${parts.map(format).join(' ')}`)
  if (!logFile || process.env.CRAPCUT_LOG_CONSOLE) console.log(line)
  if (!logFile) return
  rotate(logFile)
  try {
    appendFileSync(logFile, `${line}\n`)
  } catch {
    // ignore
  }
}

export interface Logger {
  info: (...parts: unknown[]) => void
  warn: (...parts: unknown[]) => void
  error: (...parts: unknown[]) => void
}

export function logger(scope: string): Logger {
  return {
    info: (...p) => write('INFO', scope, p),
    warn: (...p) => write('WARN', scope, p),
    error: (...p) => write('ERROR', scope, p)
  }
}
