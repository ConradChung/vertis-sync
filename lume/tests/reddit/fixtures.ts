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
