/**
 * The model sometimes writes HTML (`<a href>`, web-search `<cite index="…">`,
 * `<b>`, `<br>`), which the chat's Markdown renderer would show as raw tags.
 * Links become Markdown links, simple emphasis becomes Markdown, and other
 * known HTML tags are dropped (their text kept). Unknown `<placeholders>` such
 * as `/actions/<id>` are left alone, and code spans/fences are never touched.
 */
const KNOWN_TAGS =
  'cite|span|div|p|sup|sub|small|mark|u|s|del|ins|abbr|q|font|section|article|header|footer|figure|figcaption|blockquote|center|source|sources'

export function htmlLinksToMarkdown(text: string): string {
  // Leave code untouched: split on ``` fences and `inline` spans.
  return text
    .split(/(```[\s\S]*?(?:```|$)|`[^`\n]*`)/g)
    .map((part, i) => (i % 2 === 1 ? part : cleanHtml(part)))
    .join('')
}

function cleanHtml(s: string): string {
  return s
    .replace(/<a\s[^>]*?href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() || href
      return `[${label.replace(/[[\]]/g, '')}](${href.replace(/\s/g, '%20').replace(/\)/g, '%29')})`
    })
    .replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, '*$2*')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(new RegExp(`</?(?:${KNOWN_TAGS})(?:\\s[^>]*)?>`, 'gi'), '')
}
