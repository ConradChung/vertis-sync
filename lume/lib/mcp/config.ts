/**
 * Which MCP tool groups are exposed. Read tools are always on. Write groups
 * are off unless LUME_MCP_WRITES says otherwise, so a deploy without the
 * variable is read-only:
 *   unset / anything else → read only
 *   internal              → + group B (internal writes: nothing leaves Lume, nothing costs money)
 *   gated                 → + group B + group C (preview then confirm; phase 3)
 * Off tools are not registered at all, so they never appear in tools/list.
 */
export type WriteMode = 'off' | 'internal' | 'gated'

export function mcpWriteMode(env: Record<string, string | undefined> = process.env): WriteMode {
  const v = (env.LUME_MCP_WRITES ?? '').trim().toLowerCase()
  return v === 'internal' || v === 'gated' ? v : 'off'
}
