// Runs in the sandboxed renderer before the page. Exposes a tiny, typed API and
// nothing else: no Node, no ipcRenderer, no arbitrary channels.

import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron'
import { EVENT_CHANNELS, INVOKE_CHANNELS } from '../shared/channels'
import type { CrapcutApi, EventChannel, InvokeChannel } from '../shared/ipc'

const channels = new Set<string>(INVOKE_CHANNELS)
const events = new Set<string>(EVENT_CHANNELS)
const safeId = /^[a-z0-9-]{6,64}$/i

const api: CrapcutApi = {
  invoke: ((channel: InvokeChannel, ...args: unknown[]) => {
    if (!channels.has(channel)) return Promise.reject(new Error('unknown channel'))
    return ipcRenderer.invoke(channel, ...args)
  }) as CrapcutApi['invoke'],
  on: ((event: EventChannel, listener: (payload: unknown) => void) => {
    if (!events.has(event)) throw new Error('unknown event')
    const wrapped = (_e: IpcRendererEvent, payload: unknown): void => listener(payload)
    ipcRenderer.on(event, wrapped)
    return () => ipcRenderer.removeListener(event, wrapped)
  }) as CrapcutApi['on'],
  clipUrl: (jobId, clipId) => {
    if (!safeId.test(jobId) || !safeId.test(clipId)) return ''
    return `crapcut-media://clip/${jobId}/${clipId}`
  },
  previewUrl: (jobId, clipId, version) => {
    if (!safeId.test(jobId) || !safeId.test(clipId)) return ''
    return `crapcut-media://preview/${jobId}/${clipId}?v=${encodeURIComponent(version)}`
  }
}

contextBridge.exposeInMainWorld('crapcut', api)
