/**
 * The few pages a CLIENT sees in a browser during install (3g): plain HTML
 * from the public install / callback routes (clients have no Lume session).
 * Every value is escaped. Pure.
 */

const escHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)

export function slackPage(title: string, lines: string[], status = 200): Response {
  const body = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escHtml(title)}</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;max-width:32rem;margin:15vh auto;padding:0 16px;color:#1a1a1a;background:#fafafa;line-height:1.5}h1{font-size:1.25rem}@media(prefers-color-scheme:dark){body{color:#eee;background:#141414}}</style></head>
<body><h1>${escHtml(title)}</h1>${lines.map((l) => `<p>${escHtml(l)}</p>`).join('')}</body></html>`
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'", 'Referrer-Policy': 'no-referrer' },
  })
}
