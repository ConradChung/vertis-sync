import type { NextConfig } from 'next'
import { fileURLToPath } from 'node:url'
import { loadSopLibrary } from './lib/copy/sop'

// The cold-email SOPs (sops/*.md, sops/clients/*.md) must parse: a malformed
// SOP fails `next build`, `next dev` and `next start` here, loudly.
loadSopLibrary()

const nextConfig: NextConfig = {
  // Lume is a second app inside the vertis-sync repo (its own lockfile).
  // Pin the workspace root so Turbopack doesn't infer the repo root.
  turbopack: { root: fileURLToPath(new URL('.', import.meta.url)) },
  // lib/copy/sop.ts reads the SOPs from disk at runtime (agent runs, the
  // update_sequence build/executor, /actions pages): ship them with every
  // server function.
  outputFileTracingIncludes: { '/**/*': ['./sops/**/*.md'] },
}

export default nextConfig
