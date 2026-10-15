import { assert, assertEquals } from 'jsr:@std/assert@1'
import { LUME_ALLOWED_ACTIONS, LUME_MAX_COUNT, LUME_MIN_COUNT, parseLumeAction, secretsMatch } from './action.ts'

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

Deno.test('lfo_count: digits only, safe integer, within [500, 50000]', () => {
  for (const bad of ['Infinity', '1e9', '0x300', '-500', ' 750 ', '50001', '499', '0', '', '9007199254740993', '750.0', '+750']) {
    assertEquals(parseLumeAction(`lfo_count:${ID}:${bad}`), null, `should reject ${JSON.stringify(bad)}`)
  }
  // A 4th segment is never a button we emit.
  assertEquals(parseLumeAction(`lfo_count:${ID}:750:junk`), null)
  assertEquals(parseLumeAction(`approve:${ID}::`), null)
})

Deno.test('accepts custom counts at or above 500 up to the ceiling', () => {
  assertEquals(parseLumeAction(`lfo_count:${ID}:750`)?.extra, '750')
  assertEquals(parseLumeAction(`lfo_count:${ID}:${LUME_MIN_COUNT}`)?.extra, String(LUME_MIN_COUNT))
  assertEquals(parseLumeAction(`lfo_count:${ID}:${LUME_MAX_COUNT}`)?.extra, String(LUME_MAX_COUNT))
  assertEquals(parseLumeAction(`lfo_count:${ID}:00750`)?.extra, '00750') // Number('00750') === 750
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
  // Telegram-only navigation and the barrier/preview screens are not Lume buttons.
  for (const dropped of ['lfo_custom', 'bar_loc', 'bar_co', 'push_next', 'push_strict', 'push_std', 'camp_pick', 'camp_tpl', 'camp_nolo']) {
    assertEquals(parseLumeAction(`${dropped}:${ID}`), null, `${dropped} should be rejected`)
  }
})

// Change detector: this list is hand-copied from the prefixes handleCallback in
// telegram-inbox/index.ts dispatches (finder_*, wd_resume, JOBS_ACTIONS,
// LFO_ACTIONS, PUSH_ACTIONS, approve/approve_enrich/deny, LUME_ACTIONS). If the
// allowlist grows, it must still be a subset of what the dispatcher handles;
// if the dispatcher drops a prefix, remove it here and from the allowlist.
Deno.test('allowlist is exactly the Lume set, and every member is a dispatcher prefix', () => {
  const lumeSends = [
    'approve', 'approve_enrich', 'deny',
    'finder_go', 'finder_skip', 'wd_resume',
    'jobs_pull', 'jobs_skip', 'jobs_write', 'jobs_discard', 'jobs_resume', 'jobs_abort', 'jobs_order_now',
    'lfo_count', 'lfo_cancel', 'lfo_abort',
    'push_go', 'push_cancel', 'camp_launch',
    'lume_ok', 'lume_no',
  ]
  assertEquals([...LUME_ALLOWED_ACTIONS].sort(), [...lumeSends].sort())

  const dispatcherHandles = new Set([
    'finder_go', 'finder_skip', 'wd_resume',
    'jobs_pull', 'jobs_skip', 'jobs_write', 'jobs_discard', 'jobs_resume', 'jobs_abort', 'jobs_order_now',
    'lfo_count', 'lfo_custom', 'lfo_cancel', 'lfo_abort',
    'camp_pick', 'camp_tpl', 'camp_launch', 'camp_nolo',
    'bar_loc', 'bar_co', 'push_next', 'push_go', 'push_strict', 'push_std', 'push_cancel',
    'approve', 'approve_enrich', 'deny',
    'lume_ok', 'lume_no',
  ])
  for (const action of LUME_ALLOWED_ACTIONS) {
    assert(dispatcherHandles.has(action), `${action} is allowlisted but handleCallback does not dispatch it`)
  }
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
