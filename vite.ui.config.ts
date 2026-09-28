// Development only: serves the UI in a browser with a fake backend
// (src/renderer/src/dev/mockApi.ts) for quick visual work. `npm run dev:ui`
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

const sample = resolve(__dirname, '.e2e/sample.mp4')
const sampleUrl = existsSync(sample) ? `/@fs/${sample.split('\\').join('/')}` : ''

export default defineConfig({
  root: resolve(__dirname, 'src/renderer'),
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared'), '@renderer': resolve(__dirname, 'src/renderer/src') } },
  plugins: [
    react(),
    {
      name: 'crapcut-csp-ui',
      transformIndexHtml: (html) =>
        html.replace(
          '%CSP%',
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; media-src 'self' blob:; img-src 'self' data:; connect-src 'self' ws://localhost:*"
        )
    }
  ],
  define: { 'import.meta.env.VITE_SAMPLE_VIDEO': JSON.stringify(sampleUrl) },
  server: { port: 5199, strictPort: true, fs: { allow: [resolve(__dirname)] } }
})
