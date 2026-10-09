import { assert, assertEquals } from 'jsr:@std/assert@1'
import { base64url, buildJwtClaims, pemToDer, SHEETS_SCOPE, TOKEN_URL } from './sheets.ts'

Deno.test('base64url has no padding or URL-unsafe characters', () => {
  const out = base64url(new Uint8Array([251, 255, 254, 0, 1]))
  assert(!out.includes('='))
  assert(!out.includes('+'))
  assert(!out.includes('/'))
  assertEquals(base64url(new TextEncoder().encode('{"alg":"RS256","typ":"JWT"}')), 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9')
})

Deno.test('pemToDer strips the armor and newlines and decodes base64', () => {
  const pem = '-----BEGIN PRIVATE KEY-----\nAAEC\nAwQF\n-----END PRIVATE KEY-----\n'
  assertEquals(Array.from(pemToDer(pem)), [0, 1, 2, 3, 4, 5])
  // Service-account JSON carries literal "\n" sequences once parsed; both forms must work.
  assertEquals(Array.from(pemToDer('-----BEGIN PRIVATE KEY-----\\nAAEC\\nAwQF\\n-----END PRIVATE KEY-----\\n')), [0, 1, 2, 3, 4, 5])
})

Deno.test('buildJwtClaims has the Google token-exchange shape', () => {
  const now = 1_760_000_000
  const c = buildJwtClaims('bot@proj.iam.gserviceaccount.com', now)
  assertEquals(c.iss, 'bot@proj.iam.gserviceaccount.com')
  assertEquals(c.scope, SHEETS_SCOPE)
  assertEquals(c.aud, TOKEN_URL)
  assertEquals(c.iat, now)
  assertEquals(c.exp, now + 3600)
})
