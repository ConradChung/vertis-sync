/**
 * The model sometimes cites with HTML (`<a href="…">text</a>`), which the chat's
 * Markdown renderer shows as raw tags. Rewrite those to Markdown links; any
 * other tag is left alone and still renders as plain text (never as HTML).
 */
export function htmlLinksToMarkdown(text: string): string {
  return text.replace(/<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
    const label = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || href
    return `[${label.replace(/[[\]]/g, '')}](${href.replace(/\s/g, '%20').replace(/\)/g, '%29')})`
  })
}
