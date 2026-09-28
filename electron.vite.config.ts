import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import type { Plugin } from 'vite'

// Strict Content Security Policy. Development needs inline scripts and a
// websocket for hot reload; the packaged app gets the strict one.
const CSP_PROD = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "font-src 'self'",
  'media-src crapcut-media:',
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')
const CSP_DEV = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  'media-src crapcut-media:',
  "connect-src 'self' ws://localhost:*",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'"
].join('; ')

function csp(): Plugin {
  return {
    name: 'crapcut-csp',
    transformIndexHtml(html, ctx) {
      return html.replace('%CSP%', ctx.server ? CSP_DEV : CSP_PROD)
    }
  }
}

const shared = resolve(__dirname, 'src/shared')

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: { alias: { '@shared': shared } },
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/main/index.ts') } } }
  },
  preload: {
    // Sandboxed preloads cannot require packages, so everything is bundled.
    resolve: { alias: { '@shared': shared } },
    build: {
      // Sandboxed preloads must be CommonJS.
      rollupOptions: {
        input: { index: resolve(__dirname, 'src/preload/index.ts') },
        output: { format: 'cjs', entryFileNames: '[name].cjs' }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    resolve: { alias: { '@shared': shared, '@renderer': resolve(__dirname, 'src/renderer/src') } },
    plugins: [react(), csp()],
    build: { rollupOptions: { input: { index: resolve(__dirname, 'src/renderer/index.html') } } }
  }
})
