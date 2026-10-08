# One-off personal context sources

How to gather **historical, export-only** personal data for a Lobu org running the `personal-agent` example. These complement the live connectors declared in `lobu.config.ts` and any others you add in the dashboard.

Set `org` in `lobu.config.ts` to your workspace slug (the example defaults to `personal-agent`). Connection slugs below use short generic names — change them in config if you run multiple accounts of the same type.

For durable facts, ingest into `learning` entities or `save_memory` — not as file-path references.

## Live connectors

**Declared in `lobu.config.ts`:**

| Connector | Slug | Feeds |
|-----------|------|-------|
| Revolut | `revolut` | `transactions` → `account`, `subscription`, `trip` |

**Commonly added alongside this example** (via dashboard or extended config):

| Connector | Suggested slug | Feeds / notes |
|-----------|----------------|---------------|
| LinkedIn | `linkedin` | Home feed, company pages |
| Spotify | `spotify` | Recently played, playlists, top tracks |
| WhatsApp | `whatsapp` | Messages (`whatsapp.web` through the paired browser) |
| Gmail | `gmail` | The `threads` feed supports both indexed sync and direct source reads. Optional `config.query` scope; agents pass a per-feed `query` to `feeds.readMany` (Gmail merges it as search syntax). Default: unbounded mailbox |
| X | `x` | `my_tweets`, `liked_tweets`, `bookmarks`, `direct_messages`, `home_feed` — OAuth when scopes allow, otherwise paired Owletto Chrome |
| YouTube | `youtube` | `liked_videos`, `playlists` (OAuth). **Watch history** is not in the YouTube API — use Google Takeout |
| Chrome | `chrome`, `chrome-history`, `chrome-downloads`, `chrome-bookmarks` | Browsing + downloads |
| Apple Photos / Calendar / Reminders / Screen Time | `apple-photos`, `calendar`, `reminders`, `apple-screen-time` | Device data |
| Local folder | `local-folder` | Watched directories |

**Trips** are Revolut-derived only (foreign card-spend clusters). Passport, visa, or ILR history belongs in travel **learnings**, not `trip` entities.

---

## YouTube & LinkedIn — live sync vs exports

Both services split into **ongoing live ingest** (connectors) and **one-off archives** (official downloads). Use live for what the API or extension can reach; use exports for deep history the API does not expose.

### YouTube

#### What the live connector covers (OAuth)

The bundled `youtube` connector provides sync-only feeds. Connect Google in the dashboard, then add feeds:

| Feed | What you get | Auth |
|------|----------------|------|
| `liked_videos` | Videos you have liked (indexed sync) | Google OAuth + `youtube.readonly` |
| `playlists` | Your playlists and (optionally) videos inside each | Same |
| `videos` | Scheduled ingest of a **fixed** public keyword (`search_query`) | OAuth or `YOUTUBE_API_KEY` |

**On-demand actions** (via `operations.execute` — results are not synced):

| Action | What you get | Auth |
|--------|----------------|------|
| `search` | Public YouTube keyword search now | OAuth or API key |
| `get_video` | One video's metadata (+ optional transcript/comments) | OAuth or API key |
| `search_liked_videos` | Filter your likes by title/channel | OAuth |
| `list_playlists` | Your playlist catalog | OAuth |
| `get_playlist` | Videos in one playlist (+ optional filter) | OAuth |

Use **feeds** for durable memory (`search_memory`); use **actions** when the agent needs a live lookup.

**Setup:**

1. Dashboard → **Connections** → add connector `youtube`, slug e.g. `youtube`.
2. **Connect** → sign in with Google and grant YouTube read access.
3. **Feeds** → create `liked_videos` and `playlists` (defaults are fine).
4. Run sync or wait for the schedule; rows land in `events` and become searchable via `search_memory`.

**Not available live:** watch history. The YouTube Data API has no watch-history endpoint — Google keeps that out of third-party apps.

#### Download watch history (Google Takeout)

For full watch history (including mobile/TV views the Chrome extension would miss):

1. Open https://takeout.google.com (same Google account as YouTube).
2. **Deselect all**, then enable **YouTube and YouTube Music** only (or include other products if you want a broader archive).
3. Click **All YouTube data included** → ensure **history** is checked. Optionally include **subscriptions**, **playlists**, **comments** for overlap with live feeds.
4. Choose **Export once**, **.zip**, and a size that fits your mailbox (large histories split across multiple zips).
5. Submit → wait for the email (minutes to hours) → download each part and unzip.

**Paths inside the archive** (names vary slightly by export date):

```
Takeout/
  YouTube and YouTube Music/
    history/
      watch-history.html          # primary watch log (HTML table)
    playlists/
      playlists.csv               # optional — overlaps live `playlists` feed
    subscriptions/
      subscriptions.csv           # channels you follow
```

Some exports also ship JSON under `history/` instead of HTML. Lobu has no Takeout parser yet — treat the export as a **one-off backfill**:

- Drop `watch-history.html` (or the whole `Takeout/` folder) into a **local folder** feed (`local.directory` on Lobu for Mac) so the file is ingested as a document, **or**
- Summarise key facts into **learning** entities / `save_memory` after you skim the export.

**Partial live alternative:** `chrome.history` (Owletto Chrome + `history` permission) captures `youtube.com/watch?v=...` visits from the browser (~90-day backfill + live). Good for forward-looking web viewing; not a full account history.

| Source | Coverage |
|--------|----------|
| OAuth `liked_videos` / `playlists` | Likes and curated lists, ongoing |
| Takeout `watch-history.html` | Full watch log, one-off / periodic re-export |
| `chrome.history` | Browser watch URLs only, ongoing |

---

### LinkedIn

#### What the live connector covers (Chrome extension)

The example `linkedin` connector (in `linkedin.connector.ts`) scrapes via the **paired Owletto Chrome extension** — you must be signed into linkedin.com in that browser profile.

| Feed | What you get | Requires |
|------|----------------|----------|
| `home_feed` | Your personalised feed (`linkedin.com/feed/`) | Extension + LinkedIn session |
| `company_updates` | Posts from a company page URL in feed config | Extension + `company_url` |
| `jobs` | Open roles on a company page | Extension + `company_url` |

**Setup:**

1. Pair Owletto for Chrome with your org’s worker.
2. Sign in to LinkedIn in the extension’s Chrome profile.
3. Dashboard → **Connections** → add connector `linkedin` (example connector from `lobu apply` / extended config).
4. Add feed `home_feed` for your timeline; add `company_updates` / `jobs` only if you track specific company pages.
5. Sync runs on the worker; the extension executes the scrape. New posts accumulate in `events`.

**Not available live:** full connection graph, message archive, complete career CSVs, endorsements, or pre-account history. The extension reads what’s on the pages you scrape today, not LinkedIn’s full account dump.

#### Download your LinkedIn archive (official export)

For career timeline, connections, education, skills, and message history:

1. Open https://www.linkedin.com/mypreferences/d/download-my-data (or **Settings & Privacy** → **Data privacy** → **Get a copy of your data**).
2. Choose **Download larger data archive** (not the “ready within minutes” lite export) if you want messages and full history.
3. Confirm the request. LinkedIn emails when the archive is ready — often **24–72 hours**, sometimes longer.
4. Use the link in the email to download the `.zip` (may be multiple parts).

**Typical contents** (exact filenames can vary):

```
LinkedIn_Export_<date>.zip
  Profile.csv                 # headline, location, summary
  Positions.csv               # job history
  Education.csv
  Skills.csv
  Certifications.csv
  Connections.csv             # first name, last name, email, company, position, connected on
  Messages/                   # per-conversation HTML or CSV shards
  Invitations.csv
  Endorsements_Received.csv
  Rich_Attachments/           # media from messages, if included
```

**Ingest today (no bundled Takeout-style parser):**

| File | Suggested Lobu target |
|------|------------------------|
| `Positions.csv` + `Education.csv` | **Career history** learning |
| `Profile.csv` + `Skills.csv` | Professional identity facts in learnings |
| `Connections.csv` | Seed `person` entities for close network (not the whole CSV — curate) |
| `Messages/` | Episodic `save_memory` only for threads not captured elsewhere |

Live `home_feed` keeps your timeline current; the zip **backfills** graph and career data the scraper never sees.

---

## One-off exports

### Google Takeout

| | |
|---|---|
| **Download** | https://takeout.google.com |
| **Pick** | Calendar, Mail, Photos, Chrome, Drive, YouTube, Location History |
| **Format** | `.zip` shards |
| **Ingest** | Calendar overlaps `calendar`; Mail overlaps `gmail`; Photos may need a Takeout-specific connector |
| **YouTube history** | See [YouTube → Download watch history](#download-watch-history-google-takeout) above |
| **Status** | _Not started_ |

---

### X / Twitter

**Live connector** (`x`): OAuth + paired Chrome for `my_tweets`, `liked_tweets`, `bookmarks`, `direct_messages`, and `home_feed`. Use feeds for ongoing memory; Takeout below is for deep history the live path does not reach.

| | |
|---|---|
| **Download** | https://x.com/settings/download_your_data |
| **Format** | `twitter-YYYY-MM-DD-<hash>.zip` → `data/tweets.js`, DMs, media |
| **Ingest** | Backfill only — summarise into learnings or episodic memory |
| **Status** | _Not started_ |

---

### ChatGPT / OpenAI

| | |
|---|---|
| **Download** | ChatGPT → Settings → Data controls → Export data |
| **Format** | `conversations.json`, `memories.json`, `projects.json`, `users.json` |
| **Ingest** | Diff `memories.json` + project descriptions into learnings; skip ephemeral devtool threads |
| **Status** | _Not started_ |

---

### LinkedIn

Full step-by-step: [LinkedIn → Download your archive](#download-your-linkedin-archive-official-export) above.

| | |
|---|---|
| **Download** | https://www.linkedin.com/mypreferences/d/download-my-data |
| **Wait** | Email link, typically 24–72 hours |
| **Ingest** | Live `home_feed` for ongoing posts; zip backfills career + connections |
| **Status** | _Not started_ |

---

### WhatsApp

| | |
|---|---|
| **Download** | In app: chat → ⋮ → More → Export chat |
| **Format** | `.zip` with `_chat.txt` + media |
| **Ingest** | `whatsapp` / `whatsapp.web` is primary; exports for chats outside the paired browser |
| **Status** | _Not started_ |

---

### Passport / ILR / travel evidence

| | |
|---|---|
| **Source** | Passport scans, visa spreadsheets, flight logs |
| **Ingest** | Travel learnings (e.g. **UK travel and absence history**, **International travel profile**) |
| **Status** | _Not started_ |

---

### Apple / iCloud

| | |
|---|---|
| **Download** | https://privacy.apple.com |
| **Ingest** | Overlaps Apple connectors; use for backfill only |

---

### Meta (Facebook / Instagram)

| | |
|---|---|
| **Download** | https://www.facebook.com/dyi |
| **Status** | _Not started_ |

---

### Spotify

| | |
|---|---|
| **Download** | https://www.spotify.com/account/privacy/ |
| **Ingest** | `spotify` connector is live once connected; export only for offline archive |

---

## Ingestion playbook

Replace `personal-agent` with your org slug if you changed it in `lobu.config.ts`.

```bash
lobu login
lobu apply                    # provision org + connectors from lobu.config.ts
lobu memory org set personal-agent

# Search before writing
lobu memory run search_memory '{"query":"career linkedin"}' --org personal-agent

# Update a learning
lobu memory run run_sdk --org personal-agent '{"script":"export default async (_ctx, c) => c.entities.update({ entity_id: <id>, metadata: { ... } })"}'

# Append an episodic note
lobu memory run save_memory --org personal-agent '{"content":"...","semantic_type":"observation"}'
```

**Rules:** search first · supersede stale learnings · no file paths in memory · credentials never ingested.

---

## Backfill queue

Track your own progress here (or delete this section once done).

| Priority | Source | Status |
|----------|--------|--------|
| P0 | ChatGPT export | _Not started_ |
| P0 | Passport / ILR travel | _Not started_ |
| P1 | Twitter archive | _Not started_ |
| P1 | LinkedIn data zip | _Not started_ |
| P1 | YouTube Takeout (watch history) | _Not started_ |
| P2 | Google Takeout (full) | _Not started_ |
| P3 | WhatsApp exports | _Not started_ |
