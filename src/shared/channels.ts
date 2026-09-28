// Channel names only (no dependencies), so the sandboxed preload stays tiny.

export const INVOKE_CHANNELS = [
  'app:info',
  'app:openLogFolder',
  'app:openOutputFolder',
  'app:openLicence',
  'app:checkUpdates',
  'app:installUpdate',
  'setup:status',
  'setup:start',
  'setup:cancel',
  'jobs:list',
  'jobs:create',
  'jobs:pause',
  'jobs:resume',
  'jobs:cancel',
  'jobs:delete',
  'clips:list',
  'clips:update',
  'clips:reset',
  'clips:pickMusic',
  'layouts:list',
  'layouts:save',
  'layouts:delete',
  'layouts:setDefault',
  'exports:list',
  'exports:start',
  'exports:cancel',
  'exports:show',
  'channelWatch:status',
  'channelWatch:set',
  'channelWatch:clear'
] as const

export const EVENT_CHANNELS = ['setup:status', 'jobs:changed', 'exports:changed', 'app:update', 'channelWatch:changed', 'jobs:focus'] as const
