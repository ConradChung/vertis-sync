// F5Bot alert emails (shape modelled on F5Bot's digest: section, keyword,
// title, link, excerpt). Replace with a real forwarded alert once one lands.
export const PLAIN = `F5Bot found something!

Reddit Posts (1)

Keyword: appfolio
/r/PropertyManagement: Looking for alternatives to AppFolio for 200 units
https://www.reddit.com/r/PropertyManagement/comments/1gx2abc/looking_for_alternatives_to_appfolio/
We've been on AppFolio for three years and the fees keep going up...

Reddit Comments (1)

Keyword: buildium
/r/Landlord: Re: Best software for a small portfolio?
https://www.reddit.com/r/Landlord/comments/1gx3def/best_software_for_a_small_portfolio/lyq9xyz/
Buildium has been fine for us, support is slow though.

Unsubscribe: https://f5bot.com/unsubscribe?x=1
`

export const HTML = `<html><body><p>F5Bot found something!</p>
<p><b>Keyword: appfolio</b><br>
<a href="https://f5bot.com/r?u=https%3A%2F%2Fwww.reddit.com%2Fr%2FPropertyManagement%2Fcomments%2F1gx2abc%2Flooking_for_alternatives_to_appfolio%2F">/r/PropertyManagement: Looking for alternatives to AppFolio</a><br>
We&#39;ve been on AppFolio for three years &amp; the fees keep going up...</p>
</body></html>`

/** Reddit's <post>.json */
export const POST_JSON = [
  { kind: 'Listing', data: { children: [{ kind: 't3', data: { id: '1gx2abc', author: 'small_pm_owner', subreddit: 'PropertyManagement', title: 'Looking for alternatives to AppFolio for 200 units', selftext: "We've been on AppFolio for three years and the fees keep going up. Thinking of switching from it.", created_utc: 1763900000 } }] } },
  { kind: 'Listing', data: { children: [] } },
]

/** Reddit's <comment permalink>.json */
export const COMMENT_JSON = [
  { kind: 'Listing', data: { children: [{ kind: 't3', data: { id: '1gx3def', author: 'op_person', subreddit: 'Landlord', title: 'Best software for a small portfolio?', selftext: 'Which one?', created_utc: 1763890000 } }] } },
  { kind: 'Listing', data: { children: [{ kind: 't1', data: { id: 'lyq9xyz', author: 'rental_rita', subreddit: 'Landlord', body: 'Buildium has been fine for us, support is slow though.', created_utc: 1763895000 } }] } },
]

const enc = (u: string) => `https://f5bot.com/url?u=${encodeURIComponent(u)}&i=100040257&h=3876ca8d`
/** F5Bot's real plain-text layout (Nov 23): hit line `(/r/Sub/): 'Title' by author <redirect link>`, no excerpt, 13-char comment ids. */
export const REAL_PLAIN = `F5Bot found something!

Keyword: "appfolio"

Reddit Comments (/r/PropertyManagement/): 'Maintenance Management System Recommendations' by CoolWax ${enc('https://www.reddit.com/r/PropertyManagement/comments/1y1f63z/c/19sxv5w0vh7t9?context=3')}

Reddit Posts (/r/PropertyManagement/): 'Don't love Buildium, switching from it?' by TransportationOld902 ${enc('https://www.reddit.com/r/PropertyManagement/comments/1y00b49/buildium_price_questions/')}

Stray 100% sign here.
`

/**
 * F5Bot's real HTML part (alert of Nov 23, ids/handles as received; head,
 * styles and ad trimmed). One post hit matched on two keywords (two
 * <br>-separated excerpts, the second inside the first), three comment hits,
 * then the "comments or suggestions" footer.
 */
const hitP = (meta: string, u: string, title: string, author: string, excerpt: string) =>
  `<p class="f5-hit" style="margin:8px 0 16px 10px;"><span class="f5-meta" style="font-size:14px; color:#666666;">${meta}</span> <a href="https://f5bot.com/url?u=${encodeURIComponent(u)}&amp;i=100040256&amp;h=9bbb0d43" style="color:#F15A24; font-weight:bold;">${title}</a> <span class="f5-meta" style="font-size:14px; color:#666666;">by ${author}</span><br>\n<span class="f5-excerpt" style="font-family:Menlo,Consolas,'Lucida Console',Monaco,monospace; word-break:break-word;">${excerpt}</span></p>`
export const REAL_HTML = `<!DOCTYPE html><html><head><title>F5Bot</title><style>.f5-hit { color:#E8E8E8 !important; }</style></head>
<body class="f5-page"><span class="f5-preheader" style="display:none;">New mentions: buildium, appfolio</span>
<p class="f5-heading" style="font-size:22px;">F5Bot found something!</p>
<h2 class="f5-hit-heading">Keywords: &quot;buildium&quot;, &quot;appfolio&quot;</h2>
${hitP(
  'Reddit Posts (/r/PropertyManagement/):',
  'https://www.reddit.com/r/PropertyManagement/comments/1y1f63z/maintenance_management_system_recommendations/',
  'Maintenance Management System Recommendations',
  'CoolWax',
  "it would take me hours to write it all, but it&#039;s built like someone&#039;s college coding project from 2015. We&#039;ve been exploring switching from a <strong>Buildium</strong>/Meld combo to AppFolio, or keeping <strong>Buildium</strong> &amp; moving maintenance.<br>\nto write it all, but it&#039;s built like someone&#039;s college coding project from 2015. We&#039;ve been exploring switching from a Buildium/Meld combo to <strong>AppFolio</strong>, or keeping Buildium &amp; moving maintenance."
)}
<h2 class="f5-hit-heading">Keyword: &quot;appfolio&quot;</h2>
${hitP(
  'Reddit Comments (/r/PropertyManagement/):',
  'https://www.reddit.com/r/PropertyManagement/comments/1y1f63z/c/19sxucq3repr9?context=3',
  'Maintenance Management System Recommendations',
  'corsair130',
  '<strong>Appfolio</strong>s native work order management system is pretty weak. <strong>Appfolio</strong> will try to nickel and dime you every time you turn around.'
)}
${hitP(
  'Reddit Comments (/r/PropertyManagement/):',
  'https://www.reddit.com/r/PropertyManagement/comments/1y1f63z/c/19sxv5w0vh7tu?context=3',
  'Maintenance Management System Recommendations',
  'CoolWax',
  'Thanks for the reply! I feel like anything is better than Property Meld at this point, and maybe we need a full <strong>AppFolio</strong> integration. '
)}
<p style="margin:16px 0 0 0;">Do you have comments or suggestions about F5Bot? Please hit reply and let me know what you think!</p>
<p class="f5-footer">You are receiving this email because you signed up for keyword alerts at f5bot.com. Copyright &copy; 2017-2026 F5Bot LLC.</p>
</body></html>`

/** The plain part of the same alert as REAL_HTML. */
export const REAL_HTML_PLAIN = `F5Bot found something!

Keywords: "buildium", "appfolio"

Reddit Posts (/r/PropertyManagement/): 'Maintenance Management System Recommendations' by CoolWax ${enc('https://www.reddit.com/r/PropertyManagement/comments/1y1f63z/maintenance_management_system_recommendations/')}

Keyword: "appfolio"

Reddit Comments (/r/PropertyManagement/): 'Maintenance Management System Recommendations' by corsair130 ${enc('https://www.reddit.com/r/PropertyManagement/comments/1y1f63z/c/19sxucq3repr9?context=3')}

Reddit Comments (/r/PropertyManagement/): 'Maintenance Management System Recommendations' by CoolWax ${enc('https://www.reddit.com/r/PropertyManagement/comments/1y1f63z/c/19sxv5w0vh7tu?context=3')}

Do you have comments or suggestions about F5Bot? Please hit reply and let me know what you think!
`
