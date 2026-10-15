import { assert, assertEquals } from 'jsr:@std/assert@1'
import { LUME_ALLOWED_ACTIONS, LUME_MIN_COUNT, parseLumeAction, secretsMatch } from './action.ts'

const ID = '00000000-0000-0000-0000-000000000001'

Deno.test('rejects malformed ids and sub-minimum counts', () => {
  assertEquals(parseLumeAction('approve:not-a-uuid'), null)
  assertEquals(parseLumeAction('approve:'), null)
  assertEquals(parseLumeAction('approve'), null)
  assertEquals(parseLumeAction(''), null)
  assertEquals(parseLumeAction(`lfo_count:${ID}:300`), null)
  assertEquals(parseLumeAction(`lfo_count:${ID}`), null)
  assertEquals(parseLumeAction(`lfo_count:${ID}:abc`), null)
})

Deno.test('accepts custom counts at or above 500', () => {
  assertEquals(parseLumeAction(`lfo_count:${ID}:750`)?.extra, '750')
  assertEquals(parseLumeAction(`lfo_count:${ID}:${LUME_MIN_COUNT}`)?.extra, String(LUME_MIN_COUNT))
})

Deno.test('only allowlisted actions are accepted', () => {
  for (const action of LUME_ALLOWED_ACTIONS) {
    const extra = action === 'lfo_count' ? ':500' : ''
    const parsed = parseLumeAction(`${action}:${ID}${extra}`)
    assert(parsed !== null, `${action} should parse`)
    assertEquals(parsed.action, action)
    assertEquals(parsed.targetId, ID)
  }
  assertEquals(parseLumeAction(`nope:${ID}`), null)
  assertEquals(parseLumeAction(`APPROVE:${ID}`), null)
  assertEquals(parseLumeAction(`approve_now:${ID}`), null)
  assertEquals(parseLumeAction(`:${ID}`), null)
})

Deno.test('allowlist covers every dispatcher prefix', () => {
  const expected = [
    'finder_go', 'finder_skip', 'wd_resume',
    'jobs_pull', 'jobs_skip', 'jobs_write', 'jobs_discard', 'jobs_resume', 'jobs_abort', 'jobs_order_now',
    'lfo_count', 'lfo_custom', 'lfo_cancel', 'lfo_abort',
    'camp_pick', 'camp_tpl', 'camp_launch', 'camp_nolo',
    'bar_loc', 'bar_co', 'push_next', 'push_go', 'push_strict', 'push_std', 'push_cancel',
    'approve', 'approve_enrich', 'deny',
    'lume_ok', 'lume_no',
  ]
  assertEquals([...LUME_ALLOWED_ACTIONS].sort(), expected.sort())
})

Deno.test('camp_pick / camp_tpl keep their numeric extra', () => {
  assertEquals(parseLumeAction(`camp_pick:${ID}:3`), { action: 'camp_pick', targetId: ID, extra: '3' })
  assertEquals(parseLumeAction(`camp_tpl:${ID}:0`), { action: 'camp_tpl', targetId: ID, extra: '0' })
  // No extra is still a parse; the handler decides what an absent index means.
  assertEquals(parseLumeAction(`camp_pick:${ID}`), { action: 'camp_pick', targetId: ID, extra: undefined })
})

Deno.test('secretsMatch: equal secrets match, anything else does not', async () => {
  assert(await secretsMatch('abc123', 'abc123'))
  assert(!(await secretsMatch('abc124', 'abc123')))
  assert(!(await secretsMatch('abc1230', 'abc123')))
  assert(!(await secretsMatch('abc12', 'abc123')))
})

Deno.test('secretsMatch: an unset expected secret never matches', async () => {
  assert(!(await secretsMatch('', '')))
  assert(!(await secretsMatch('anything', '')))
  assert(!(await secretsMatch('', 'configured')))
})
