// IPC handlers. Every request is checked: it must come from our own window,
// on a known channel, with arguments that pass the zod schema.

import { dialog, ipcMain, shell, type BrowserWindow, type IpcMainInvokeEvent } from 'electron'
import { existsSync } from 'node:fs'
import type { Platform } from '@shared/editPlan'
import { Invoke, type InvokeChannel, type InvokeResult } from '@shared/ipc'
import type { Events, EventChannel } from '@shared/ipc'
import { optionalModelArtifactIds, type OptionalModelId } from '@shared/optionalModels'
import { parseVodUrl } from '@shared/vodUrl'
import type { Clip } from '@shared/types'
import { applyClipPatch, resetClip } from './clips'
import { hasEnoughHistory, type TasteDecision } from './core/taste'
import { ensureClipNormalized, ensureClipsNormalized } from './pipeline/clipNormalize'
import { isAppUrl, openExternalSafely } from './security'
import type { AppServices } from './services'
import type { ToolId } from './tools/manifest'
import { UserError } from './util/errors'
import { logFolder, logger } from './util/log'

const log = logger('ipc')

type Handler<C extends InvokeChannel> = (...args: never[]) => Promise<InvokeResult[C]> | InvokeResult[C]

export function registerIpc(services: AppServices, getWindow: () => BrowserWindow | null, devServer: string | undefined): void {
  const { store, runner, exporter, bestOf, autoEditPreview, setup, updater, paths, channelWatch, autostart, hardware } = services

  const handlers: { [C in InvokeChannel]: Handler<C> } = {
    'app:info': () => services.appInfo(),
    'app:openLogFolder': () => {
      const dir = logFolder()
      if (dir) void shell.openPath(dir)
    },
    'app:openOutputFolder': () => {
      void shell.openPath(paths.output)
    },
    'app:openLicence': (url: string) => openExternalSafely(url, services.allowedLinks),
    'app:checkUpdates': () => updater.check(),
    'app:installUpdate': () => updater.install(),

    'setup:status': () => setup.status(),
    'setup:start': () => {
      void setup.start().then(() => services.onSetupFinished())
    },
    'setup:cancel': () => setup.cancel(),

    'jobs:list': () => store.jobs(),
    'jobs:create': (text: string) => {
      const parsed = parseVodUrl(text)
      if (!parsed.ok) return { ok: false, reason: parsed.reason }
      if (!setup.isReady()) return { ok: false, reason: 'CrapCut is still getting ready. Finish setup first.' }
      const existing = store.findActiveJobForVod(parsed.id)
      if (existing) {
        const job = store.job(existing)
        if (job && job.status !== 'review' && !runner.isActive(existing)) runner.enqueue(existing)
        return { ok: true, jobId: existing, existing: true }
      }
      const jobId = store.createJob(parsed.url, parsed.id)
      runner.enqueue(jobId)
      return { ok: true, jobId, existing: false }
    },
    'jobs:pause': (id: string) => runner.pause(id),
    'jobs:resume': (id: string) => runner.enqueue(id),
    'jobs:cancel': (id: string) => runner.cancel(id),
    'jobs:delete': (id: string) => runner.delete(id),

    'clips:list': (jobId: string) => ensureClipsNormalized(store, paths, store.clips(jobId)),
    'clips:update': async (clipId: string, patch) => {
      const clip = await requireClip(clipId)
      const job = store.job(clip.jobId)
      const next = applyClipPatch(clip, patch as never, (id) => !!store.layout(id), job?.vod?.durationSec ?? clip.end)
      store.saveClip(next)
      syncTasteDecision(next)
      // The last caption style picked becomes the default for new clips.
      if (next.captions.styleId !== clip.captions.styleId) store.set('defaultCaptionStyleId', next.captions.styleId)
      return next
    },
    'clips:reset': async (clipId: string) => {
      const next = resetClip(await requireClip(clipId))
      store.saveClip(next)
      syncTasteDecision(next)
      return next
    },
    'clips:previewAutoEdit': (clipId: string, format) => autoEditPreview.request(clipId, format),
    'clips:pickMusic': async (clipId: string) => {
      const clip = await requireClip(clipId)
      const win = getWindow()
      const opts = { title: 'Choose music', properties: ['openFile' as const], filters: [{ name: 'Music', extensions: ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus'] }] }
      const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts)
      const file = res.filePaths[0]
      if (res.canceled || !file || !existsSync(file)) return null
      // Paths only ever come from this dialog, never from the UI.
      const next: Clip = { ...clip, musicPath: file, audio: 'voice_music' }
      store.saveClip(next)
      return next
    },

    'layouts:list': () => ({ layouts: store.layouts(), defaultId: store.get<string>('defaultLayoutId') }),
    'layouts:save': (layout) => {
      store.saveLayout(layout as never)
      return layout as never
    },
    'layouts:delete': (id: string) => {
      store.deleteLayout(id)
      if (store.get<string>('defaultLayoutId') === id) store.set('defaultLayoutId', null)
    },
    'layouts:setDefault': (id: string | null) => store.set('defaultLayoutId', id && store.layout(id) ? id : null),

    'exports:list': (jobId: string) => exporter.list(jobId),
    'exports:start': (jobId: string, clipIds: string[]) => exporter.add(jobId, clipIds),
    'exports:cancel': (id: string) => exporter.cancel(id),
    'exports:show': (id: string) => {
      const item = exporter.list().find((e) => e.id === id)
      if (item?.file && existsSync(item.file)) shell.showItemInFolder(item.file)
    },

    'bestOf:list': (jobId: string) => bestOf.list(jobId),
    'bestOf:start': (jobId: string) => bestOf.start(jobId),
    'bestOf:cancel': (id: string) => bestOf.cancel(id),
    'bestOf:show': (id: string) => {
      const item = bestOf.list().find((e) => e.id === id)
      if (item?.file && existsSync(item.file)) shell.showItemInFolder(item.file)
    },

    'work:list': () => {
      // Recent ones only: enough to see the batch under way and how much of it is done.
      const since = Date.now() - 24 * 3600 * 1000
      const recent = <T extends { status: string; createdAt: number }>(items: T[]): T[] => items.filter((i) => i.status === 'queued' || i.status === 'running' || i.createdAt >= since)
      return { exports: recent(exporter.list()), bestOf: recent(bestOf.list()) }
    },

    'taste:status': () => ({ tuned: hasEnoughHistory(store.getTasteHistory()) }),
    'taste:reset': () => store.clearTasteHistory(),
    'channelWatch:status': () => channelWatch.status(),
    'channelWatch:set': (text: string) => channelWatch.set(text),
    'channelWatch:clear': () => channelWatch.clear(),

    'settings:getAutostart': () => autostart.status(),
    'settings:setAutostart': (enabled: boolean) => autostart.setEnabled(enabled),
    'settings:getExportPlatforms': () => exporter.platforms(),
    'settings:setExportPlatforms': (platforms: Platform[]) => exporter.setPlatforms(platforms),

    'models:download': (id: OptionalModelId) => {
      void setup.start(optionalModelArtifactIds(id, hardware) as ToolId[])
    },
    'models:remove': (id: OptionalModelId) => {
      setup.remove(optionalModelArtifactIds(id, hardware) as ToolId[], () => runner.hasWork() || exporter.hasWork() || bestOf.hasWork())
    }
  }

  async function requireClip(id: string): Promise<Clip> {
    const clip = store.clip(id)
    if (!clip) throw new UserError('That clip no longer exists.', { retryable: false })
    return ensureClipNormalized(store, paths, clip)
  }

  /** Keeps the taste history in step with a clip's current decision and cut. */
  function syncTasteDecision(clip: Clip): void {
    if (!clip.signals) return
    const decision: TasteDecision | null =
      clip.status === 'pending' ? null : { status: clip.status, signals: clip.signals, suggested: clip.suggested, final: { start: clip.start, end: clip.end } }
    store.recordTasteDecision(clip.id, decision)
  }

  for (const channel of Object.keys(Invoke) as InvokeChannel[]) {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (!event.senderFrame || !isAppUrl(event.senderFrame.url, devServer)) {
        log.warn(`rejected ${channel} from ${event.senderFrame?.url ?? 'unknown'}`)
        throw new Error('not allowed')
      }
      const parsed = Invoke[channel].safeParse(args)
      if (!parsed.success) {
        log.warn(`invalid arguments for ${channel}`, parsed.error.issues.slice(0, 3))
        throw new Error('invalid request')
      }
      try {
        return await (handlers[channel] as (...a: unknown[]) => unknown)(...(parsed.data as unknown[]))
      } catch (err) {
        log.error(`${channel} failed`, err)
        // Only the plain sentence crosses to the UI.
        throw new Error(err instanceof UserError ? err.userMessage : 'Something went wrong. Details are in the log.')
      }
    })
  }
}

export function sendEvent<E extends EventChannel>(win: BrowserWindow | null, event: E, payload: Events[E]): void {
  if (win && !win.isDestroyed()) win.webContents.send(event, payload)
}
