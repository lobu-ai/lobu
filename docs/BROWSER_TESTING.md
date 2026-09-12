# Browser-driven verification (authenticated)

For any UI verification that needs a signed-in session (past the auth wall), mint a session cookie from the DB and drive the **paired Owletto extension** through the Lobu connector-operations bridge (`lobu call manage_operations`, or the SDK `operations` namespace). This runs in the user's real logged-in Chrome — no separate headless browser, no CDP, no extra browser tooling to install.

## Scope

The forged session cookie authenticates the **web admin REST mounted at `/`** (`/api/auth/*`, `/api/<orgSlug>/...`, the SPA — anything `lobu apply` and the web app talk to). It does **NOT** authenticate the **public Agent API at `/lobu`** (`/lobu/api/v1/agents/*`, `/lobu/api/v1/agents/<id>/sessions`) — that path expects a JWT bearer from the OAuth device flow (`lobu login`) or a PAT. If `/lobu/api/v1/agents` returns `401` despite a valid cookie, switch to `lobu chat` / `lobu token`.

## Pick a target

Local dev backend (with prod DB attached over Tailscale): `https://<your-tailscale-host>.ts.net:8443`. Prod: `https://app.lobu.ai`.

## Grab the secret + session token

```bash
# Local dev backend uses .env's BETTER_AUTH_SECRET
SECRET=$(grep '^BETTER_AUTH_SECRET=' .env | cut -d= -f2-)

# Prod uses the secret on the K8s pod
SECRET=$(kubectl exec -n summaries-prod \
  $(kubectl get pod -n summaries-prod -l app.kubernetes.io/name=lobu-app -o name | head -1 | sed 's|pod/||') \
  -- printenv BETTER_AUTH_SECRET)
```

Session token from the DB. With no local `DATABASE_URL` set, exec psql inside the prod DB pod (the prod DB serves both targets):

```bash
DBURL=$(kubectl exec -n summaries-prod <lobu-app-pod> -- printenv DATABASE_URL)
PGPASS=$(printf '%s' "$DBURL" | sed -E 's#.*://[^:]+:([^@]+)@.*#\1#')
TOKEN=$(kubectl exec -n summaries-prod lobu-ai-prod-db-1 -- \
  env PGPASSWORD="$PGPASS" psql -h lobu-ai-prod-db-pooler -U summaries -d owletto -tAc \
  "SELECT token FROM session WHERE \"userId\" = '<user_id>' AND \"expiresAt\" > NOW() ORDER BY \"updatedAt\" DESC LIMIT 1")
```

## Sign the cookie

better-auth uses HMAC-SHA256, base64, then URL-encode — base64**url** does *not* validate.

```bash
SIGNED=$(SECRET="$SECRET" TOKEN="$TOKEN" node -e '
  const {createHmac}=require("node:crypto");
  const sig=createHmac("sha256",process.env.SECRET).update(process.env.TOKEN).digest("base64");
  console.log(encodeURIComponent(`${process.env.TOKEN}.${sig}`));
')
```

Cookie name is `__Secure-better-auth.session_token` whenever the baseURL is `https://` (prod and Tailscale dev qualify; only plain-http localhost uses the unprefixed `better-auth.session_token`).

## Find the Chrome connection

Browser actions dispatch to a paired Chrome extension connection. Pass the organization slug explicitly:

```bash
lobu call manage_connections --org <org-slug> --arg action=list --raw
```

Pick the `chrome` connector with `status: active` on the machine whose browser you want to drive. `operations.listAvailable({ connection_id })` reports per-target `readiness` and `execution_targets` — use it to check the device is actually online before a long verification.

## Drive the browser

Multi-step verifications are one `run_sdk` script (the tab id threads through every call):

```bash
lobu call run_sdk --arg script='
export default async (ctx, client) => {
  const CHROME = <chrome-connection-id>;
  const COOKIE = "<SIGNED>";
  // 1. Open the app origin in a fresh background tab.
  const nav = await client.operations.execute({
    connection_id: CHROME, operation_key: "navigate",
    input: { url: "https://app.lobu.ai/", open_in_new_tab: true, wait_for_load: true },
  });
  const tab = nav.output.tab_id;
  // 2. Plant the signed session cookie.
  await client.operations.execute({
    connection_id: CHROME, operation_key: "evaluate",
    input: { tab_id: tab, expression: `document.cookie='"'"'__Secure-better-auth.session_token=${COOKIE}; path=/; secure; samesite=lax'"'"'`, await_promise: false },
  });
  // 3. Navigate the SAME tab to the authenticated page.
  await client.operations.execute({
    connection_id: CHROME, operation_key: "navigate",
    input: { tab_id: tab, url: "https://app.lobu.ai/<path>", wait_for_load: true },
  });
  // 4. Assert on the DOM (title/text/refs), or use get_accessibility_tree / screenshot.
  const probe = await client.operations.execute({
    connection_id: CHROME, operation_key: "evaluate",
    input: { tab_id: tab, expression: `(async () => { await new Promise(r => setTimeout(r, 3000)); return { title: document.title, snippet: document.body.innerText.slice(0, 300) }; })()`, await_promise: true },
  });
  // 5. MANDATORY: expire the planted cookie before closing the tab. See below.
  await client.operations.execute({
    connection_id: CHROME, operation_key: "evaluate",
    input: { tab_id: tab, expression: `document.cookie='"'"'__Secure-better-auth.session_token=; path=/; max-age=0; secure; samesite=lax'"'"'`, await_promise: false },
  });
  // 6. Clean up the tab when done.
  await client.operations.execute({ connection_id: CHROME, operation_key: "close_tab", input: { tab_id: tab } });
  return probe.output;
};
' --raw
```

### Always expire the planted cookie (step 5 is not optional)

`document.cookie` writes a **host-only** cookie (`app.lobu.ai`), while a real sign-in writes
the same name at `Domain=.lobu.ai`. Both then live in the jar and the browser sends both.

This used to lock the human out of `app.lobu.ai` permanently. Resolution went to whichever
cookie came **first**, which RFC 6265 §5.4 makes the **oldest**, so a leftover planted cookie
outranked every later sign-in — and each new sign-in minted a strictly newer cookie that could
never win. It cost a full debugging session on 2026-08-06.

Two server-side changes closed that:

- `auth/resolve-session.ts` resolves a duplicated jar **on merit** rather than by position, so
  order no longer decides who authenticates.
- `auth/session-cookie-scope.ts` expires the host-only twin whenever a response sets a
  domain-scoped auth cookie, so a sign-in collapses the jar back to one.

**Still expire what you planted.** A planted cookie is a live session that outlives your test,
and neither change makes an extra session in someone's browser a good idea.

To clear one by hand:

```js
for (const d of ['', '; domain=app.lobu.ai', '; domain=.lobu.ai'])
  document.cookie = '__Secure-better-auth.session_token=; max-age=0; path=/' + d + '; secure; samesite=lax';
```

For one-off actions, `lobu call manage_operations` is quicker:

```bash
lobu call manage_operations --org <org-slug> --arg action=execute \
  --arg connection_id=<chrome-connection-id> --arg operation_key=navigate \
  --arg input:='{"url":"https://app.lobu.ai/<path>","wait_for_load":true,"open_in_new_tab":true}' --raw
```

Chrome ops: `navigate` (new tab, existing `tab_id`, or `persistent` agent window), `evaluate`, `get_accessibility_tree` (`filter: interactive|visible|all`), `wait_for_selector`, `click_ref`, `type_ref`, `screenshot`, `show_notification`, `network_intercept_*`, `close_tab`.

## Driving the paired Owletto extension (connector debugging)

The recipe above drives the same **paired Owletto extension** that extension-scrape connectors (Revolut, LinkedIn) use — the Chrome that holds the user's live sessions. Anything said there applies: `operations.execute` → `dispatchChromeActionToExtension` → device-worker queue → the paired extension. No deploy required.

The standalone `lobu connector run` command has been retired. Use the connector-operations bridge above for device-worker connectors; they do not need a browser auth profile.

Gotchas:
- `search_sdk operations` surfaces the `operations` namespace and current method signatures. Use `Object.keys(client)` inside a `run_sdk` script only when checking discovery/runtime parity.
- Select the Chrome connection for the browser the user is actually watching, and verify the resolved connection/worker in the operation run. A data connection's `device_worker_id` is scrape affinity; connector-initiated actions inherit it, so `completed` does not prove a human-visible tab opened on the right machine.
- Sessions that re-auth often (Revolut, ~hourly) must be freshly logged in *in the paired Chrome* right before you navigate+evaluate, or the fresh tab redirects to the sign-in wall.
- Per-call dispatch latency is 5–60s and virtualized lists recycle content out — for paginated scrapes, iterate inside the connector's own run, not via one-shot `evaluate`s.
- **Connector-side changes ship via re-apply, not the app release.** Per-org connectors (`examples/personal-agent`) live in `connector_definitions`/`connector_versions` and only update on `lobu apply` (or `connections.installConnector` for a single bundle). An organization-scoped artifact shadows the shared artifact for the active version. Catalog refresh skips keys with no bundled source, but re-syncs keys that do have bundled source and can reset their active definition to bundled metadata, so verify the active version after deploy rather than assuming an override survived. An app deploy that adds a *capability* (e.g. `show_notification`) does nothing until the connector that *calls* it is re-applied. **And a new chrome action also needs the matching handler in the extension build** — dispatching `show_notification` to an older installed extension fails with `Owletto for Chrome: unknown dispatch ... action_key='show_notification'`. So three things gate such a notification: an up-to-date extension build (the handler), a re-applied connector (the call), and macOS notification permission on the extension.
