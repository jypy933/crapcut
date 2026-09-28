// Pure decision logic for whether closing the window should hide it to the
// tray instead of quitting, kept apart from the Electron wiring in
// ../index.ts so it can be unit-tested on its own.

export interface CloseState {
  jobRunning: boolean
  exportRunning: boolean
  channelWatched: boolean
}

/** Background work would be interrupted, so closing the window hides it instead of quitting. */
export function shouldHideOnClose(state: CloseState): boolean {
  return state.jobRunning || state.exportRunning || state.channelWatched
}
