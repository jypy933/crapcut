// End-to-end run on a real public VOD, without Electron:
//   set E2E_VOD=https://www.twitch.tv/videos/<id>   (a short VOD, 5-20 min)
//   npm run e2e
// Downloads the real pinned tools into .e2e/home (checksums verified), runs the
// whole pipeline, exports the best clip in both formats and checks the files.
// The language model is skipped unless E2E_LLM=1 (it is a multi-GB download).

import { existsSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { ExportItem, JobSummary, Layout } from '../../src/shared/types'
import { parseVodUrl } from '../../src/shared/vodUrl'

const VOD = process.env.E2E_VOD ?? ''
const ROOT = resolve(__dirname, '../..')
const HOME = join(ROOT, '.e2e', 'home')
const OUT = join(ROOT, '.e2e', 'out')

describe.skipIf(!VOD)('end to end on a real VOD', () => {
  it(
    'turns a VOD into exported, captioned clips',
    async () => {
      process.env.CRAPCUT_HOME = HOME
      process.env.CRAPCUT_OUTPUT = OUT
      process.env.CRAPCUT_LOG_CONSOLE = '1'
      mkdirSync(HOME, { recursive: true })

      const { resolvePaths } = await import('../../src/main/paths')
      const { initLog } = await import('../../src/main/util/log')
      const { Store } = await import('../../src/main/store')
      const { detectHardware } = await import('../../src/main/tools/gpu')
      const { ToolRegistry } = await import('../../src/main/tools/registry')
      const { neededArtifacts } = await import('../../src/main/tools/manifest')
      const { JobRunner } = await import('../../src/main/pipeline/runner')
      const { Exporter } = await import('../../src/main/pipeline/exporter')
      const { GpuLock } = await import('../../src/main/pipeline/gpuLock')
      const { probeMedia } = await import('../../src/main/pipeline/media')

      const paths = resolvePaths({ resources: join(ROOT, 'resources') })
      initLog(paths.logs)
      const hw = await detectHardware()
      console.log('hardware', JSON.stringify({ gpu: hw.primary?.name, whisper: hw.whisper, llm: hw.llm }))

      const tools = new ToolRegistry(paths.tools, paths.downloads)
      for (const a of neededArtifacts(hw)) {
        if (a.id.startsWith('model-llm') && process.env.E2E_LLM !== '1') continue
        if (a.id === 'llama' && process.env.E2E_LLM !== '1' && !process.env.E2E_LLM_MODEL) continue
        if (tools.isInstalled(a)) continue
        const t0 = Date.now()
        await tools.install(a, undefined, () => {})
        console.log(`installed ${a.id} in ${Math.round((Date.now() - t0) / 1000)} s`)
      }

      const parsed = parseVodUrl(VOD)
      if (!parsed.ok) throw new Error(parsed.reason)
      const store = new Store(join(HOME, 'e2e.db'))
      const gpu = new GpuLock()
      let last: JobSummary | null = null
      let lastLine = ''
      const runner = new JobRunner(store, paths, tools, () => hw, gpu, {
        onJobChanged: (job) => {
          last = job
          const s = job.currentStep
          const line = `${job.status} ${s ?? ''} ${s ? Math.round(job.steps[s].progress * 100) : ''}% ${s && job.steps[s].detail ? job.steps[s].detail : ''}`
          if (line !== lastLine) console.log(line)
          lastLine = line
        },
        onJobReady: () => {}
      }, { llmModelOverride: process.env.E2E_LLM_MODEL ? resolve(process.env.E2E_LLM_MODEL) : undefined })

      const existing = store.findActiveJobForVod(parsed.id)
      const jobId = existing ?? store.createJob(parsed.url, parsed.id)
      // Re-find moments on a finished job when testing the language model.
      if (existing && process.env.E2E_LLM_MODEL) store.resetStepsFrom(jobId, 'moments')
      const started = Date.now()
      runner.enqueue(jobId)
      while (!last || !['review', 'failed', 'cancelled'].includes((last as JobSummary).status) || store.job(jobId)!.status === 'running') {
        await new Promise((r) => setTimeout(r, 1000))
        last = store.job(jobId)
        if (last && (last.status === 'review' || last.status === 'failed')) break
      }
      const job = store.job(jobId)!
      console.log(`pipeline finished in ${Math.round((Date.now() - started) / 1000)} s with status ${job.status} ${job.error ?? ''}`)
      expect(job.status).toBe('review')

      const clips = store.clips(jobId)
      console.log(clips.map((c) => `#${c.rank} ${c.start.toFixed(1)}-${c.end.toFixed(1)} score ${c.score} "${c.title}" (${c.reason}) words=${c.words.length}`).join('\n'))
      expect(clips.length).toBeGreaterThan(0)
      for (const c of clips) {
        expect(c.source).not.toBeNull()
        expect(existsSync(join(paths.jobs, jobId, 'clips', `${c.id}.mp4`))).toBe(true)
        expect(c.end - c.start).toBeGreaterThanOrEqual(3)
      }

      // Export the best clip in both formats with a facecam layout.
      const layout: Layout = { id: 'e2e-layout', name: 'E2E', kind: 'cam_game', cam: { x: 0.74, y: 0.02, w: 0.25, h: 0.3 }, game: { x: 0, y: 0, w: 1, h: 1 } }
      store.saveLayout(layout)
      const best = clips[0]!
      store.saveClip({ ...best, status: 'accepted', layoutId: layout.id, formats: { vertical: true, horizontal: true } })
      const done = new Map<string, ExportItem>()
      const exporter = new Exporter(store, paths, tools, () => hw, gpu, {
        onChanged: (item) => {
          if (item.status === 'done' || item.status === 'failed') done.set(item.id, item)
        }
      })
      const ids = exporter.add(jobId, [best.id])
      expect(ids).toHaveLength(2)
      const t1 = Date.now()
      while (done.size < ids.length) await new Promise((r) => setTimeout(r, 500))
      console.log(`exports finished in ${Math.round((Date.now() - t1) / 1000)} s`)

      const ffprobe = tools.require('ffmpeg').replace(/ffmpeg\.exe$/i, 'ffprobe.exe')
      for (const item of done.values()) {
        expect(item.status, item.error ?? '').toBe('done')
        const info = await probeMedia(ffprobe, item.file!)
        console.log(item.format, item.file, JSON.stringify(info))
        expect(info.hasAudio).toBe(true)
        expect(Math.abs(info.duration - (best.end - best.start))).toBeLessThan(0.3)
        if (item.format === 'vertical') expect([info.width, info.height]).toEqual([1080, 1920])
        else expect([info.width, info.height]).toEqual([1920, 1080])
      }
      store.close()
    },
    3 * 60 * 60 * 1000
  )
})
