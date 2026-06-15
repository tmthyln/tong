import { fileURLToPath, URL } from 'node:url'

import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import vueDevTools from 'vite-plugin-vue-devtools'

import { cloudflare } from "@cloudflare/vite-plugin"
import agents from 'agents/vite'
import pkg from './package.json'

// https://vite.dev/config/
export default defineConfig({
	define: {
		__APP_VERSION__: JSON.stringify(pkg.version),
		__BUILD_DATE__: JSON.stringify(new Date().toISOString().slice(0, 10)),
	},
	plugins: [
		vue(),
		vueDevTools(),
		cloudflare(),
		// Transforms the Agents SDK's TC39 @callable decorators (Oxc/dev can't
		// parse them) — without this `npm run dev` fails to start.
		agents(),
	],
	resolve: {
		alias: {
			'@': fileURLToPath(new URL('./src', import.meta.url))
		},
	},
	server: {
		watch: {
			// Ignore generated files that might trigger HMR before WS is ready
			ignored: ['**/node_modules/**', '**/dist/**', '**/.wrangler/**'],
		},
	},
})
