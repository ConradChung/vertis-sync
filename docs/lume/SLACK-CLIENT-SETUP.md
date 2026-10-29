# Client Slack app: owner setup (inbox manager 3g)

Lume is a Slack app your clients add to **their own** workspace. Each positive reply on a campaign bound to their
channel is posted there with a lead card, the drafted reply, and (in Client mode) **Approve**, **Edit** and **Skip**.
In a lead's thread, `@Lume <question>` answers from Lume's records, read-only. Design: "Client Slack agent" in
`docs/lume/2026-10-28-inbox-manager-design.md`.

Until all four env vars below are set, Lume reports Slack as **not configured**: nothing is posted, the Slack routes
answer 503, and Settings → Slack shows which variables are missing. Telegram and the `slack-inbox` CSV intake (your
own Slack) are not affected.

## 1. Create the app from the manifest

1. Open <https://api.slack.com/apps> → **Create New App** → **From an app manifest**, pick your own workspace as the
   development workspace.
2. Paste `docs/lume/slack-app-manifest.yml`. It sets the bot scopes (`chat:write`, `app_mentions:read`,
   `channels:read`, `groups:read` only), the OAuth redirect
   `https://lume-amber-alpha.vercel.app/api/slack/oauth/callback`, the interactivity URL `/api/slack/interactions`
   and the events URL `/api/slack/events` (`app_mention`, `app_uninstalled`, `tokens_revoked`).
3. Slack verifies the events URL when you save. That only succeeds once step 2 is deployed; until then, save the
   manifest without events, deploy, then re-verify the URL under **Event Subscriptions**.

## 2. Set the env vars on Vercel (project `lume`, Production)

| Variable | Where it comes from |
|---|---|
| `SLACK_CLIENT_ID` | App → Basic Information → App Credentials → Client ID |
| `SLACK_CLIENT_SECRET` | same page → Client Secret |
| `SLACK_SIGNING_SECRET` | same page → Signing Secret |
| `LUME_SLACK_TOKEN_KEY` | You generate it: `openssl rand -base64 32` (32 bytes; base64 or 64 hex characters) |

`LUME_URL` must already be `https://lume-amber-alpha.vercel.app` (the redirect is built from it and must match the
manifest). Redeploy after setting them.

**Token encryption (decision):** each client's bot token is encrypted by Lume itself (AES-256-GCM, key
`LUME_SLACK_TOKEN_KEY`, the workspace id as associated data) before it is stored in `lume_slack_installs`. The
database only ever holds ciphertext. Keep the key only in Vercel. Rotating it makes every stored token unreadable, so
each client must reinstall from a new link.

## 3. Enable public distribution

App → **Manage Distribution** → work through the checklist (the redirect URL is already set; remove any hard-coded
token) → **Activate Public Distribution**. Without this, only your own workspace can install it. You do not need
Slack Marketplace listing.

## 4. Send each client the install link

Settings → Slack → **Generate link** (valid 1–30 days, default 7) → **Copy**, and send it. The client opens it, clicks
**Allow** in Slack, and lands on a "Lume is installed" page telling them to `/invite @Lume` to their channel.

- The link is signed and expires; anyone holding it can install until then, so send it directly. A workspace that
  installs sees **nothing** until you bind one of its channels.
- You get a feed item ("Lume was installed in …") on every install.
- **Revoke** in Settings → Slack revokes the workspace's token and stops all posting and approvals from it.
  If the client removes the app, Lume marks it revoked by itself (`app_uninstalled` / `tokens_revoked`).

## 5. Bind channels

Settings → Slack → the workspace → **Bind a channel**:

- **Channel**: the bot lists the channels it can see. A private channel appears only after the client invited
  `@Lume`; Lume can post only where it is a member.
- **Vertical**: the vertical whose campaigns this channel follows.
- **Campaigns**: tick some to narrow it; none ticked means all of the vertical's campaigns. A campaign you later
  remove from the vertical stops being posted here.
- **Lead-card fields** the client sees: name, title, company, website, phone, LinkedIn, location, their reply, CRM
  stage. A hidden field is never posted or answered in `@Lume`. A field Lume does not hold is shown as "missing",
  never guessed. (Email addresses are never shown.)
- **Pause** stops new posts without losing the binding; **Remove** unbinds it.

Posts start with the next positive reply (no backfill).

## 6. Pick each campaign's reply mode

Settings → Verticals → **Reply approval** (or the Campaigns tab), per campaign:

| Mode | In the client's channel | Who can approve |
|---|---|---|
| `owner` (default) | Lead card + draft, no buttons: "Awaiting Conrad's approval" | You, `/operator`, a Grok Bot (never its own draft) |
| `client` | Lead card + draft + **Approve / Edit / Skip** | The client in Slack, or you |
| `auto` | Lead card + draft: "Auto mode: Lume sends this after its safety checks" | Nobody needs to (the grant) |

Rules in every mode:

- A possible **unsubscribe or hostile** reply never gets buttons; you handle it.
- A client's **Edit** saves the new text as their draft. It stays awaiting, and the same Slack user cannot approve it:
  you, another client user, or the master bot does.
- **Approve** is recorded as `decided_via='client'` with the Slack user and workspace ids. The executor then runs every
  live check (fresh thread read, newer message, already replied, label, Lost deal, blocklist) and re-checks the client
  approval itself (still Client mode, workspace still installed and bound, not the approver's own edit, no opt-out in
  the fresh text). Anything off and nothing is sent.
- Nothing is ever sent on silence.
- After a decision or send, the post updates to show the outcome.

## `@Lume` in the channel

- In a lead's thread: that lead's visible fields and status (drafted, awaiting, sent, skipped).
- Elsewhere: `@Lume Acme` searches the channel's campaigns' positive replies by name or company (else the five newest).
- It is a fixed lookup, not a chat model (decision: no model can be talked out of its scope, and it costs nothing).
- Asking it to **enrich** (find an email or phone, Apollo, Clay…) runs nothing: the client is told it went to you,
  and you get an owner-only feed item to decide.

## Checks after deploying

1. Settings → Slack shows no "not configured" banner.
2. Install into a test workspace from a fresh link, `/invite @Lume`, bind the channel.
3. Set one test campaign to `client`; when its next positive reply arrives, the card posts; draft a reply and the post
   gains the draft and buttons; Edit, then Approve from another user (or approve as yourself in Lume).
4. `@Lume status?` in the post's thread answers there.
