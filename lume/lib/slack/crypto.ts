import { createCipheriv, createDecipheriv, createHmac, randomBytes } from 'node:crypto'

/**
 * Bot tokens at rest (decision, 3g): app-level AES-256-GCM with the 32-byte
 * key in env `LUME_SLACK_TOKEN_KEY` (base64 or hex), not pgsodium, so the
 * database (and anyone with SQL access) only ever holds ciphertext, and the
 * key lives where the other app secrets do (Vercel env). Format
 * `v1:` + base64url(iv[12] | tag[16] | ciphertext). The workspace's team id is
 * the associated data: a ciphertext copied onto another workspace's row does
 * not decrypt. Rotating the key means reinstalling (tokens re-encrypt on
 * install). Pure.
 */

const IV_BYTES = 12
const TAG_BYTES = 16

export function parseTokenKey(raw: string | null | undefined): Buffer | null {
  const s = (raw ?? '').trim()
  if (!s) return null
  if (/^[0-9a-fA-F]{64}$/.test(s)) return Buffer.from(s, 'hex')
  if (/^[A-Za-z0-9+/_-]{43}=?$/.test(s)) {
    const b = Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64')
    return b.length === 32 ? b : null
  }
  return null
}

function keyOrThrow(raw: string | null | undefined): Buffer {
  const key = parseTokenKey(raw)
  if (!key) throw new Error('LUME_SLACK_TOKEN_KEY must be 32 bytes (base64 or 64 hex characters)')
  return key
}

export function encryptToken(token: string, teamId: string, rawKey: string | null | undefined = process.env.LUME_SLACK_TOKEN_KEY): string {
  const key = keyOrThrow(rawKey)
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv('aes-256-gcm', key, iv)
  cipher.setAAD(Buffer.from(`lume-slack:${teamId}`))
  const ct = Buffer.concat([cipher.update(token, 'utf8'), cipher.final()])
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), ct]).toString('base64url')}`
}

export function decryptToken(enc: string, teamId: string, rawKey: string | null | undefined = process.env.LUME_SLACK_TOKEN_KEY): string {
  const key = keyOrThrow(rawKey)
  if (!enc.startsWith('v1:')) throw new Error('unknown token format')
  const buf = Buffer.from(enc.slice(3), 'base64url')
  if (buf.length <= IV_BYTES + TAG_BYTES) throw new Error('token ciphertext too short')
  const decipher = createDecipheriv('aes-256-gcm', key, buf.subarray(0, IV_BYTES))
  decipher.setAAD(Buffer.from(`lume-slack:${teamId}`))
  decipher.setAuthTag(buf.subarray(IV_BYTES, IV_BYTES + TAG_BYTES))
  return Buffer.concat([decipher.update(buf.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]).toString('utf8')
}

/** A purpose-bound HMAC key derived from LUME_SLACK_TOKEN_KEY (install links, OAuth state). */
export function derivedKey(rawKey: string | null | undefined, purpose: string): Buffer {
  return createHmac('sha256', keyOrThrow(rawKey)).update(`lume-slack-derive:${purpose}`).digest()
}
