import { fileURLToPath, URL } from 'node:url'
import { defineConfig, configDefaults } from 'vitest/config'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  test: {
    include: ['**/*.test.ts'],
    // Playwright e2e specs live in e2e/ and are run via `npm run test:e2e`.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})