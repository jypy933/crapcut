// UI tests that drive the real, built Electron app (npm run build first):
//   npm run test:ui
// The smoke test needs no network. Set E2E_VOD to also run the full
// click-through flow (paste link -> review -> keep -> export) using the tools
// already installed by `npm run e2e` in .e2e/home.

import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { _electron as electron, type ElectronApplication, type Page } from 'playwright-core'
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = resolve(__dirname, '../..')
const built = existsSync(join(ROOT, 'out', 'main', 'index.js'))

async function launch(home: string): Promise<{ app: ElectronApplication; page: Page }> {
  const app = await electron.launch({
    args: [ROOT],
    cwd: ROOT,
    env: { ...process.env, CRAPCUT_HOME: home, CRAPCUT_OUTPUT: join(home, 'out'), ELECTRON_RENDERER_URL: '' }
  })
  const page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  return { app, page }
}

describe.skipIf(!built)('app smoke test', () => {
  const home = mkdtempSync(join(tmpdir(), 'crapcut-ui-'))
  let app: ElectronApplication | null = null
  afterAll(async () => {
    await app?.close()
    rmSync(home, { recursive: true, force: true })
  })

  it('starts on the setup screen with a locked-down renderer', async () => {
    const l = await launch(home)
    app = l.app
    const page = l.page
    await page.getByText('Let’s get CrapCut ready').waitFor({ timeout: 30_000 })
    expect(await page.getByText('FFmpeg').count()).toBeGreaterThan(0)

    // The page is served from our own protocol with a strict CSP.
    expect(page.url()).toBe('app://bundle/index.html')
    const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content')
    expect(csp).toContain("script-src 'self'")
    expect(csp).not.toContain('unsafe')

    // No Node in the renderer, and only our tiny API.
    const env = await page.evaluate(() => ({
      require: typeof (window as unknown as { require?: unknown }).require,
      process: typeof (window as unknown as { process?: unknown }).process,
      api: Object.keys((window as unknown as { crapcut: object }).crapcut).sort()
    }))
    expect(env).toEqual({ require: 'undefined', process: 'undefined', api: ['clipUrl', 'invoke', 'on'] })

    // Unknown channels and bad arguments are refused.
    const refused = await page.evaluate(async () => {
      const api = (window as unknown as { crapcut: { invoke: (...a: unknown[]) => Promise<unknown> } }).crapcut
      const out: string[] = []
      for (const call of [() => api.invoke('shell:exec', 'calc'), () => api.invoke('jobs:create', 42), () => api.invoke('jobs:delete', '../../etc')]) {
        try {
          await call()
          out.push('allowed')
        } catch {
          out.push('refused')
        }
      }
      return out
    })
    expect(refused).toEqual(['refused', 'refused', 'refused'])

    // Pages cannot open other windows or navigate away.
    const popup = await page.evaluate(() => window.open('https://example.com') === null)
    expect(popup).toBe(true)
  }, 90_000)

  it('shows licences on the About screen', async () => {
    const page = await app!.firstWindow()
    await page.getByRole('button', { name: 'About' }).click()
    await page.getByText('Licences').waitFor()
    expect(await page.getByText('GPL-3.0').count()).toBeGreaterThan(0)
    expect(await page.getByText('Apache-2.0').count()).toBeGreaterThan(0)
  }, 30_000)
})

const VOD = process.env.E2E_VOD ?? ''
const e2eHome = join(ROOT, '.e2e', 'home')

describe.skipIf(!built || !VOD || !existsSync(join(e2eHome, 'tools')))('full flow in the real app', () => {
  let app: ElectronApplication | null = null
  afterAll(async () => {
    await app?.close()
  })

  it(
    'pastes a link, reviews, keeps and exports a clip',
    async () => {
      const l = await launch(e2eHome)
      app = l.app
      const page = l.page
      await page.getByPlaceholder('https://www.twitch.tv/videos/…').fill(VOD)
      await page.getByRole('button', { name: 'Find clips' }).click()
      await page.getByRole('button', { name: /Review/ }).first().waitFor({ timeout: 60 * 60 * 1000 })
      await page.getByRole('button', { name: /Review/ }).first().click()

      // The preview video loads through the media protocol.
      await page.waitForFunction(() => (document.querySelector('video')?.readyState ?? 0) >= 2, undefined, { timeout: 60_000 })
      await page.keyboard.press(' ')
      await page.waitForTimeout(3000)
      await page.keyboard.press(' ')
      await page.screenshot({ path: join(ROOT, '.e2e', 'review.png') })
      await page.getByRole('button', { name: /Mark facecam|Edit/ }).click()
      await page.waitForTimeout(1000)
      await page.screenshot({ path: join(ROOT, '.e2e', 'layout.png') })
      await page.getByRole('button', { name: 'Save layout' }).click()
      await page.waitForTimeout(1500)
      await page.screenshot({ path: join(ROOT, '.e2e', 'review-cam.png') })
      await page.keyboard.press('k')
      await page.getByRole('button', { name: /Export 1 kept clip/ }).click()
      await page.getByRole('button', { name: 'Show' }).first().waitFor({ timeout: 10 * 60 * 1000 })
      await page.screenshot({ path: join(ROOT, '.e2e', 'exported.png') })
    },
    2 * 60 * 60 * 1000
  )
})
