import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles.css'

async function boot(): Promise<void> {
  // Development only: view the UI in a plain browser with a fake backend.
  if (import.meta.env.DEV && !window.crapcut) {
    const { installMockApi } = await import('./dev/mockApi')
    installMockApi(import.meta.env.VITE_SAMPLE_VIDEO ?? '')
  }
  const { App } = await import('./App')
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>
  )
}

void boot()
