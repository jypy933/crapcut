// Runs external tools with argument arrays (never a shell), streams their
// output line by line, and kills the whole process tree on cancel.

import { execFile, spawn } from 'node:child_process'
import { constants, setPriority } from 'node:os'
import { CancelledError } from '../util/errors'
import { logger } from '../util/log'
import { TASKKILL_EXE } from './systemTools'

const log = logger('process')

export interface RunOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  signal?: AbortSignal
  /** Called for each line of stdout/stderr (split on \n and \r). */
  onStdout?: (line: string) => void
  onStderr?: (line: string) => void
  /** Kill the tool if it runs longer than this. */
  timeoutMs?: number
  /** How much of each stream to keep for the log and error details. */
  keepBytes?: number
  /** Process priority below normal so the PC stays responsive. */
  lowPriority?: boolean
}

export interface RunResult {
  code: number
  stdout: string
  stderr: string
}

export class ToolFailedError extends Error {
  constructor(
    readonly tool: string,
    readonly code: number | null,
    readonly stderrTail: string
  ) {
    super(`${tool} exited with ${code}: ${stderrTail.slice(-2000)}`)
    this.name = 'ToolFailedError'
  }
}

/** Kills a process and everything it started (yt-dlp starts ffmpeg, etc.). */
export function killTree(pid: number): void {
  if (process.platform === 'win32') {
    execFile(TASKKILL_EXE, ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => {})
  } else {
    try {
      process.kill(-pid, 'SIGKILL')
    } catch {
      try {
        process.kill(pid, 'SIGKILL')
      } catch {
        // already gone
      }
    }
  }
}

function lineSplitter(onLine: ((line: string) => void) | undefined): (chunk: string) => void {
  let buf = ''
  return (chunk: string) => {
    if (!onLine) return
    buf += chunk
    const parts = buf.split(/\r\n|\n|\r/)
    buf = parts.pop() ?? ''
    for (const p of parts) if (p) onLine(p)
  }
}

function tail(s: string, max: number): string {
  return s.length > max ? s.slice(s.length - max) : s
}

export function runTool(file: string, args: string[], opts: RunOptions = {}): Promise<RunResult> {
  const keep = opts.keepBytes ?? 64 * 1024
  const name = file.split(/[\\/]/).pop() ?? file
  return new Promise((resolve, reject) => {
    if (opts.signal?.aborted) return reject(new CancelledError())
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      shell: false,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    const outLines = lineSplitter(opts.onStdout)
    const errLines = lineSplitter(opts.onStderr)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (d: string) => {
      stdout = tail(stdout + d, keep)
      outLines(d)
    })
    child.stderr.on('data', (d: string) => {
      stderr = tail(stderr + d, keep)
      errLines(d)
    })

    let cancelled = false
    let timedOut = false
    const onAbort = (): void => {
      cancelled = true
      if (child.pid) killTree(child.pid)
    }
    opts.signal?.addEventListener('abort', onAbort, { once: true })
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true
          if (child.pid) killTree(child.pid)
        }, opts.timeoutMs)
      : null

    if (opts.lowPriority && child.pid) {
      try {
        // Below normal keeps games and the desktop smooth during long jobs.
        setPriority(child.pid, constants.priority.PRIORITY_BELOW_NORMAL)
      } catch {
        // not fatal
      }
    }

    child.on('error', (err) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      reject(err)
    })
    child.on('close', (code) => {
      if (timer) clearTimeout(timer)
      opts.signal?.removeEventListener('abort', onAbort)
      if (cancelled) return reject(new CancelledError())
      if (timedOut) {
        log.warn(`${name} timed out`)
        return reject(new ToolFailedError(name, null, `timed out\n${tail(stderr, 4000)}`))
      }
      if (code !== 0) {
        log.warn(`${name} failed with ${code}`, tail(stderr, 4000))
        return reject(new ToolFailedError(name, code, tail(stderr, 8000)))
      }
      resolve({ code: code ?? 0, stdout, stderr })
    })
  })
}
