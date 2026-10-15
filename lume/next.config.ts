import type { NextConfig } from 'next'
import { fileURLToPath } from 'node:url'

const nextConfig: NextConfig = {
  // Lume is a second app inside the vertis-sync repo (its own lockfile).
  // Pin the workspace root so Turbopack doesn't infer the repo root.
  turbopack: { root: fileURLToPath(new URL('.', import.meta.url)) },
}

export default nextConfig
