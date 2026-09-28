// Applies "Start CrapCut with Windows" to the Windows login item. What the
// setting should be lives in core/autostart.ts, tested without touching the
// registry; this class just carries the decision out.

import { app } from 'electron'
import type { AutostartStatus } from '@shared/types'
import { resolveAutostart } from './core/autostart'
import type { Store } from './store'

const KV_KEY = 'autostart'

/** Login item argument that tells CrapCut to start hidden in the tray. */
export const HIDDEN_START_ARG = '--hidden'

export class AutostartManager {
  constructor(
    private readonly store: Store,
    /** Whether a channel is currently being watched (the default's other input). */
    private readonly channelWatched: () => boolean,
    /** Overridable in tests so they never touch the real registry. */
    private readonly apply: (settings: { openAtLogin: boolean; args?: string[] }) => void = (s) => app.setLoginItemSettings(s),
    private readonly packaged: () => boolean = () => app.isPackaged
  ) {}

  private setting(): AutostartStatus | null {
    return this.store.get<AutostartStatus>(KV_KEY)
  }

  status(): AutostartStatus {
    const setting = this.setting()
    return { enabled: resolveAutostart(setting, this.channelWatched()), userSet: setting?.userSet ?? false }
  }

  /** Re-applies the current desired state to Windows. Call at startup and whenever the channel watch changes. */
  sync(): void {
    if (!this.packaged()) return
    const enabled = resolveAutostart(this.setting(), this.channelWatched())
    this.apply(enabled ? { openAtLogin: true, args: [HIDDEN_START_ARG] } : { openAtLogin: false })
  }

  /** The user explicitly flipped the toggle; that choice sticks from now on. */
  setEnabled(enabled: boolean): AutostartStatus {
    this.store.set(KV_KEY, { userSet: true, enabled })
    this.sync()
    return this.status()
  }
}
