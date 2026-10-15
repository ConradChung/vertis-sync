import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('.', import.meta.url)),
      // `server-only` throws outside an RSC bundle; stub it so server modules
      // (lib/db/service, lib/adapters/*) can be unit-tested.
      'server-only': fileURLToPath(new URL('./tests/stubs/server-only.ts', import.meta.url)),
    },
  },
  test: {
    // Pure-logic tests run in node. Component tests opt in to jsdom with
    // a `// @vitest-environment jsdom` pragma at the top of the file.
    environment: 'node',
    include: ['tests/**/*.test.{ts,tsx}'],
  },
})
