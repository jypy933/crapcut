// Local AI tools: whisper.cpp (speech to text) and llama.cpp's llama-server
// (language model on 127.0.0.1 with a random key). Paths passed to these tools
// are relative to the CrapCut folder so non-ASCII user names cannot break them.

import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'
import { spawn, type ChildProcess } from 'node:child_process'
import { runTool, killTree, ToolFailedError } from '../tools/process'
import { CancelledError, UserError } from '../util/errors'
import { logger } from '../util/log'

const log = logger('ai')

export interface WhisperChunkOptions {
  whisper: string
  /** Working directory; model, audio and output paths are relative to it. */
  cwd: string
  model: string
  vadModel: string | null
  /** One chunk as its own WAV. whisper.cpp's -ot/-d misplace timestamps when VAD is on. */
  audio: string
  outBase: string
  language: string | null
  threads: number
  gpu: boolean
  /** Beam size; 1 means greedy decoding (fastest). */
  beam: number
  signal: AbortSignal
  onProgress: (f: number) => void
}

export function whisperArgs(o: Omit<WhisperChunkOptions, 'whisper' | 'cwd' | 'signal' | 'onProgress'>): string[] {
  const args = [
    '-m',
    o.model,
    '-f',
    o.audio,
    '-l',
    o.language ?? 'auto',
    '-ml',
    '1',
    '-sow',
    '-oj',
    '-of',
    o.outBase,
    '-pp',
    '-np',
    '-t',
    String(o.threads),
    '-bs',
    String(o.beam),
    '-bo',
    String(Math.max(1, o.beam))
  ]
  if (!o.gpu) args.push('-ng')
  if (o.vadModel) args.push('--vad', '-vm', o.vadModel)
  return args
}

export function parseWhisperProgress(line: string): number | null {
  const m = /progress\s*=\s*(\d+)%/.exec(line)
  return m ? Math.min(1, Number(m[1]) / 100) : null
}

export async function whisperChunk(o: WhisperChunkOptions): Promise<void> {
  await runTool(o.whisper, whisperArgs(o), {
    cwd: o.cwd,
    signal: o.signal,
    lowPriority: true,
    onStderr: (line) => {
      const f = parseWhisperProgress(line)
      if (f !== null) o.onProgress(f)
    },
    onStdout: (line) => {
      const f = parseWhisperProgress(line)
      if (f !== null) o.onProgress(f)
    }
  })
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer()
    srv.unref()
    srv.on('error', reject)
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      srv.close(() => resolve(port))
    })
  })
}

export interface ChatMessageIn {
  role: 'system' | 'user' | 'assistant'
  content: string
}

/** A llama-server process that lives for one pipeline step. */
export class LlamaServer {
  private child: ChildProcess | null = null
  private port = 0
  private readonly key = randomBytes(24).toString('hex')
  private stderr = ''

  constructor(
    private readonly exe: string,
    private readonly cwd: string,
    private readonly model: string,
    private readonly gpu: boolean
  ) {}

  async start(signal: AbortSignal): Promise<void> {
    this.port = await freePort()
    const args = [
      '-m',
      this.model,
      '--host',
      '127.0.0.1',
      '--port',
      String(this.port),
      '--api-key',
      this.key,
      '-c',
      '8192',
      '-np',
      '1',
      '-ngl',
      this.gpu ? '999' : '0',
      '--jinja',
      // Answers are short JSON; "thinking" models would waste the token budget.
      '--reasoning-budget',
      '0',
      '--no-webui'
    ]
    this.child = spawn(this.exe, args, { cwd: this.cwd, shell: false, windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    this.child.stderr?.setEncoding('utf8')
    this.child.stderr?.on('data', (d: string) => (this.stderr = (this.stderr + d).slice(-8000)))
    const exited = new Promise<never>((_, reject) => {
      this.child!.once('exit', (code) => reject(new ToolFailedError('llama-server', code, this.stderr)))
      this.child!.once('error', reject)
    })
    exited.catch(() => {})
    const deadline = Date.now() + 180_000
    while (Date.now() < deadline) {
      if (signal.aborted) {
        this.stop()
        throw new CancelledError()
      }
      try {
        const res = await Promise.race([fetch(`http://127.0.0.1:${this.port}/health`, { signal: AbortSignal.timeout(2000) }), exited])
        if (res.ok) {
          log.info(`llama-server ready on ${this.port} (gpu=${this.gpu})`)
          return
        }
      } catch (err) {
        if (err instanceof ToolFailedError) throw err
      }
      await new Promise((r) => setTimeout(r, 500))
    }
    this.stop()
    throw new UserError('The language model took too long to start.', { detail: this.stderr })
  }

  async complete(messages: ChatMessageIn[], schema: object, signal: AbortSignal): Promise<string> {
    const res = await fetch(`http://127.0.0.1:${this.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.key}` },
      body: JSON.stringify({
        messages,
        temperature: 0.2,
        max_tokens: 600,
        chat_template_kwargs: { enable_thinking: false },
        response_format: { type: 'json_schema', json_schema: { name: 'answer', schema, strict: true } }
      }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(120_000)])
    })
    if (!res.ok) throw new Error(`llama-server HTTP ${res.status}: ${(await res.text()).slice(0, 500)}`)
    const j = (await res.json()) as { choices?: { message?: { content?: string }; finish_reason?: string }[] }
    const choice = j.choices?.[0]
    if (choice?.finish_reason && choice.finish_reason !== 'stop') log.warn(`model stopped early: ${choice.finish_reason}`)
    return choice?.message?.content ?? ''
  }

  stop(): void {
    if (this.child?.pid && this.child.exitCode === null) killTree(this.child.pid)
    this.child = null
  }
}

/** Downloads a VOD's chat replay as a text log. */
export async function downloadChat(exe: string, vodId: string, out: string, tempDir: string, signal: AbortSignal, onProgress: (f: number) => void): Promise<void> {
  try {
    await runTool(
      exe,
      ['chatdownload', '--id', vodId, '-o', out, '--timestamp-format', 'Relative', '--collision', 'Overwrite', '--banner', 'false', '--threads', '4', '--temp-path', tempDir],
      {
        signal,
        onStdout: (line) => {
          let last: number | null = null
          for (const m of line.matchAll(/Downloading (\d+)%/g)) last = Number(m[1])
          if (last !== null) onProgress(Math.min(1, last / 100))
        }
      }
    )
  } catch (err) {
    if (err instanceof CancelledError) throw err
    const tail = err instanceof ToolFailedError ? err.stderrTail.toLowerCase() : ''
    if (tail.includes('not found') || tail.includes('invalid')) throw new UserError('Could not find the chat for that VOD.', { cause: err, retryable: false })
    throw new UserError('Downloading the chat replay failed. Try again in a few minutes.', { cause: err })
  }
}
