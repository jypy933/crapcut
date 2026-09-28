import type { CrapcutApi } from '../../shared/ipc'

declare global {
  interface Window {
    crapcut: CrapcutApi
  }
}

export {}
