// Google Sheets REST v4 client for edge functions, authenticated as a service
// account. No googleapis dependency: the JWT is signed with WebCrypto RS256 and
// exchanged for an access token at Google's token endpoint.
//
// Setup (one time, by the owner): create a service account, download its JSON
// key, share the spreadsheet with its client_email as Editor, and store the
// whole JSON in the GOOGLE_SERVICE_ACCOUNT_JSON edge-function secret.

export const SHEETS_SCOPE = 'https://www.googleapis.com/auth/spreadsheets'
export const TOKEN_URL = 'https://oauth2.googleapis.com/token'
const SHEETS_API = 'https://sheets.googleapis.com/v4/spreadsheets'

export interface ServiceAccount {
  client_email: string
  private_key: string
}

export function base64url(bytes: Uint8Array): string {
  let bin = ''
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function pemToDer(pem: string): Uint8Array<ArrayBuffer> {
  const b64 = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [A-Z ]+-----/, '')
    .replace(/-----END [A-Z ]+-----/, '')
    .replace(/\s+/g, '')
  const bin = atob(b64)
  const out = new Uint8Array(new ArrayBuffer(bin.length))
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export function buildJwtClaims(clientEmail: string, nowSeconds: number) {
  return {
    iss: clientEmail,
    scope: SHEETS_SCOPE,
    aud: TOKEN_URL,
    iat: nowSeconds,
    exp: nowSeconds + 3600,
  }
}

async function signJwt(sa: ServiceAccount): Promise<string> {
  const enc = new TextEncoder()
  const header = base64url(enc.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })))
  const claims = base64url(enc.encode(JSON.stringify(buildJwtClaims(sa.client_email, Math.floor(Date.now() / 1000)))))
  const unsigned = `${header}.${claims}`
  const key = await crypto.subtle.importKey(
    'pkcs8',
    pemToDer(sa.private_key),
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  )
  const sig = await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, enc.encode(unsigned))
  return `${unsigned}.${base64url(new Uint8Array(sig))}`
}

let cachedToken: { token: string; expiresAt: number } | null = null

export async function getAccessToken(serviceAccountJson: string): Promise<string> {
  if (cachedToken && Date.now() < cachedToken.expiresAt - 60_000) return cachedToken.token
  let sa: ServiceAccount
  try {
    sa = JSON.parse(serviceAccountJson) as ServiceAccount
  } catch {
    throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON')
  }
  if (!sa.client_email || !sa.private_key) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON lacks client_email/private_key')

  const assertion = await signJwt(sa)
  const res = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
  })
  if (!res.ok) throw new Error(`Google token exchange failed (${res.status}): ${await res.text()}`)
  const data = await res.json() as { access_token: string; expires_in: number }
  cachedToken = { token: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 }
  return data.access_token
}

async function sheetsFetch(token: string, url: string, init?: RequestInit): Promise<unknown> {
  const res = await fetch(url, {
    ...init,
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
  })
  if (!res.ok) {
    const text = await res.text()
    let msg = text
    try { msg = (JSON.parse(text) as { error?: { message?: string } }).error?.message ?? text } catch { /* raw */ }
    throw new Error(`Google Sheets ${res.status}: ${msg}`)
  }
  return res.json()
}

// Returns the grid as rows of strings. Short rows are NOT padded; use
// rowToRecord from pure.ts for that.
export async function readRange(token: string, spreadsheetId: string, rangeA1: string): Promise<string[][]> {
  const url = `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(rangeA1)}?majorDimension=ROWS&valueRenderOption=UNFORMATTED_VALUE&dateTimeRenderOption=FORMATTED_STRING`
  const data = await sheetsFetch(token, url) as { values?: unknown[][] }
  return (data.values ?? []).map(row => row.map(v => v === null || v === undefined ? '' : String(v)))
}

// values:append with RAW input: strings land as typed, no formula/number parsing.
export async function appendRows(token: string, spreadsheetId: string, rangeA1: string, rows: unknown[][]): Promise<number> {
  if (rows.length === 0) return 0
  const url = `${SHEETS_API}/${spreadsheetId}/values/${encodeURIComponent(rangeA1)}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`
  const data = await sheetsFetch(token, url, {
    method: 'POST',
    body: JSON.stringify({ majorDimension: 'ROWS', values: rows }),
  }) as { updates?: { updatedRows?: number } }
  return data.updates?.updatedRows ?? rows.length
}

export function sheetTabLink(spreadsheetId: string, gid: number): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit#gid=${gid}`
}
