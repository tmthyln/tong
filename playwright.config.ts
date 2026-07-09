import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end tests. These drive the real app — Vue SPA + the Cloudflare Worker
 * API — served by `npm run dev` (the @cloudflare/vite-plugin runs the Worker
 * in-process with local D1/DO emulation). Unit/integration tests stay in vitest
 * (`*.test.ts`); e2e specs live in `e2e/` as `*.spec.ts`.
 *
 * Note: LLM/Vectorize bindings are marked `remote = true` in wrangler.toml, so
 * flows that call them need Cloudflare auth (or stubbing). The smoke tests here
 * deliberately exercise only local surfaces (routing, auth cookie, D1-backed
 * dictionary/lexicon) so they run offline.
 */

// A dedicated port so e2e never collides with a dev server you're running by
// hand on 5173. `reuseExistingServer` lets you point tests at an already-running
// instance on this port locally, while CI always boots a fresh one.
const PORT = Number(process.env.E2E_PORT ?? 5199)
const baseURL = `http://localhost:${PORT}`

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['github'], ['html', { open: 'never' }]] : 'list',

  use: {
    baseURL,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],

  webServer: {
    command: `npm run dev -- --port ${PORT} --strictPort`,
    url: baseURL,
    reuseExistingServer: !process.env.CI,
    // The dev server builds the UMAP Docker container and boots the Worker
    // runtime on first start, so allow generous headroom.
    timeout: 180_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
