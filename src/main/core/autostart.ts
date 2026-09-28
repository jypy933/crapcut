// Pure decision logic for "Start CrapCut with Windows": on by default only
// while a channel is being watched, unless the user has explicitly chosen
// otherwise, in which case that choice sticks. Kept apart from the Windows
// registry call in ../autostart.ts so it can be unit-tested on its own.

import type { AutostartStatus } from '@shared/types'

export function resolveAutostart(setting: AutostartStatus | null, channelWatched: boolean): boolean {
  return setting?.userSet ? setting.enabled : channelWatched
}
