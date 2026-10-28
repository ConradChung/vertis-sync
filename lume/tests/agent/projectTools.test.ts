import { describe, expect, it, vi } from 'vitest'
import { TOOL_TIERS } from '@/lib/agent/permissions'
import { buildTools, type ToolDeps } from '@/lib/agent/tools'

const PID = '0f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'
const FID = '3f3c2b1a-9d8e-4f7a-8b6c-5d4e3f2a1b0c'

function setup(extra: Partial<ToolDeps> = {}) {
  const fetch = vi.fn().mockResolvedValue(new Response('{"text":"abc","next_offset":null}'))
  const tools = buildTools({
    fetch,
    createAction: vi.fn(),
    prepare: vi.fn() as never,
    agentRunId: 'r1',
    baseUrl: 'https://lume.test',
    secret: 's3cret',
    ...extra,
  })
  return { fetch, tool: tools.find((t) => t.name === 'read_project_file')! }
}

describe('read_project_file', () => {
  it('is a read tool, always present (a stable tool list keeps the cache)', () => {
    expect(TOOL_TIERS.read_project_file).toBe('read')
    expect(setup().tool).toBeTruthy()
    expect(setup({ projectId: PID }).tool).toBeTruthy()
  })

  it("reads from this chat's project only, with the offset", async () => {
    const { fetch, tool } = setup({ projectId: PID })
    expect(await tool.run({ id: FID, offset: 20000 })).toEqual({ text: 'abc', next_offset: null })
    expect(fetch.mock.calls[0][0]).toBe(`https://lume.test/api/agent/projects/${PID}/files/${FID}?offset=20000`)
    expect(fetch.mock.calls[0][1].headers.Authorization).toBe('Bearer s3cret')
  })

  it('outside a project it fails cleanly without a request', async () => {
    const { fetch, tool } = setup()
    await expect(tool.run({ id: FID })).rejects.toThrow(/not filed in a project/)
    expect(fetch).not.toHaveBeenCalled()
  })

  it('takes no project id from the model', () => {
    const { tool } = setup({ projectId: PID })
    expect(tool.inputSchema.safeParse({ id: FID, project_id: PID }).success).toBe(false)
  })
})
