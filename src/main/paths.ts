// Where CrapCut keeps things. Big files (tools, models, job work files) go to
// %LOCALAPPDATA%\CrapCut, not the roaming profile; finished clips go to
// Videos\CrapCut where the user expects them.

import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export interface AppPaths {
  root: string
  tools: string
  downloads: string
  jobs: string
  logs: string
  db: string
  output: string
  /** Read-only app resources (fonts). */
  resources: string
}

export function resolvePaths(opts: { resources: string; videos?: string }): AppPaths {
  const local = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local')
  const root = process.env.CRAPCUT_HOME ?? join(local, 'CrapCut')
  const videos = opts.videos ?? join(homedir(), 'Videos')
  const paths: AppPaths = {
    root,
    tools: join(root, 'tools'),
    downloads: join(root, 'tools', '_downloads'),
    jobs: join(root, 'jobs'),
    logs: join(root, 'logs'),
    db: join(root, 'crapcut.db'),
    output: process.env.CRAPCUT_OUTPUT ?? join(videos, 'CrapCut'),
    resources: opts.resources
  }
  for (const dir of [paths.root, paths.tools, paths.downloads, paths.jobs, paths.logs]) mkdirSync(dir, { recursive: true })
  return paths
}

export function jobDir(paths: AppPaths, jobId: string): string {
  if (!/^[a-z0-9-]{6,64}$/.test(jobId)) throw new Error('bad job id')
  return join(paths.jobs, jobId)
}
