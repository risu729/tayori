# Design

Tayori is a signed webhook relay on Cloudflare Workers. A source POSTs a signed
delivery; the relay verifies it, deduplicates it and forwards it to the target
that is active for that source's route. The name comes from _tayori_ (便り, a
letter or news).

Status: the request path, the Relay Durable Object and both MCP tools are
implemented with synthetic tests. Deployment, the Custom Domain, Access and the
Portal registration are not done yet; see [the roadmap](roadmap.md).

## Decisions

- The relay is generic, not tied to one receiver. Sources, targets and routes are
  deployed configuration; more accounts and receivers other than Grok may come
  (owner, 2026-11-21 17:22 UTC).
- The active target is set at runtime through MCP `set_active`. The relay never
  reads git or any other repository (owner, 2026-11-22 14:23 UTC).
- The first build is minimal: `/in/fumi` with a `one` route, Standard Webhooks
  inbound, `set_active` and `get_routes` over MCP, and Grok targets as Worker
  secrets set by the owner (owner, 2026-11-22 14:23 UTC).
- Registering targets through MCP is dropped. A Grok bot can create its own
  routine with a webhook trigger but cannot read the trigger's URL or key, so a
  person copies them from the routine panel (gate result, 2026-11-22 14:22 UTC).
- The repository name is `tayori` (owner, 2026-11-22 14:25 UTC).

## Words used here

- **Source**: a sender that POSTs into the relay, for example `fumi`. Each source
  has exactly one route, named after the source.
- **Target**: a URL the relay forwards to, for example `grok-b`.
- **Route**: which targets a source's deliveries go to, and how. The first build
  has only `one`: a single active target.
- **Active target**: for a `one` route, the target used right now.

## Configuration

Deployed configuration, changed only through a reviewed PR:

```jsonc
{
  "sources": { "fumi": { "bodyCheck": "fumi-notification" } },
  "targets": {
    "grok-a": { "auth": "bearer", "secret": "TARGET_GROK_A" },
    "grok-b": { "auth": "bearer", "secret": "TARGET_GROK_B" }
  },
  "routes": { "fumi": { "mode": "one", "targets": ["grok-a", "grok-b"] } }
}
```

- Each Grok account runs its bot as a Cursor automation, so a Grok target is
  that automation's webhook trigger.

- `TARGET_GROK_A` and `TARGET_GROK_B` are Worker secrets holding
  `{"url":"https://api2.cursor.sh/automations/webhook/<id>","key":"crsr_…"}`.
  The target is called with `Authorization: Bearer <key>`. No URL or key is kept
  in a repository, a chat or a log.

- `SOURCE_FUMI_SECRET` is the Standard Webhooks secret that fumi signs with.

- `ACCESS_ISSUER`, `ACCESS_AUDIENCE` and `ALLOWED_PRINCIPALS` guard `/mcp`.
  `ALLOWED_PRINCIPALS` is a JSON array such as `["user:<sub>"]`.

- Every secret is optional at deploy. Until one is set, the part that needs it
  answers 503 and nothing is forwarded.

- Runtime state lives only in a Durable Object, for example:

  ```jsonc
  { "route": "fumi", "active": "grok-b", "leaseUnix": 1795196087, "setAt": "2026-11-21T17:34:12Z" }
  ```

- A deploy never changes the active target. A `one` route with no active target
  answers 503, so the source retries.

## Request path

`POST https://tayori.takuk.me/in/<source>`:

1. **Verify.**
   - The body is at most 64 KiB.
   - The Standard Webhooks signature checks out with the source's secret, and
     the timestamp is within 300 s.
   - For `fumi`, the body also has `kind: "notification"` and a `messageId`
     matching `^mail_[a-zA-Z0-9-]{1,128}$`. Other sources get only the size and
     signature checks.
2. **Deduplicate** on (`source`, `webhook-id`):
   - if it is `forwarded`, return 200;
   - if it is `sending` and still inside its 60 s lock, return 503;
   - otherwise continue.
3. **Forward inside the Durable Object.** The Worker calls it within
   `ctx.waitUntil`, so a source that disconnects at 5 s cannot lose the record.
   - It takes the route's active target. If there is none, it answers
     `unavailable`.
   - It marks the delivery `sending`, with that target.
   - It POSTs the body bytes unchanged, with the target's authentication, the
     same `webhook-id` header, a 3 s timeout and `redirect: "manual"`.
4. **Record the outcome.** What matters is whether the request reached the
   target:
   - 2xx: `forwarded`.
   - 429, 3xx or any 5xx, or a network error before the request was sent: clear
     the record, so the next attempt resends.
   - Any other 4xx, such as 400, 401, 403, 404 or 413: clear the record and log a
     configuration error. A 401 can also mean a disabled trigger.
   - A timeout after the request was sent: `unknown`. The next attempt resends,
     which may cause a duplicate run that the receiver absorbs.
5. **Answer the source.** Return 200 when the delivery is `forwarded`.
   Otherwise, including when the Relay itself fails, return 503. If saving a
   `forwarded` record fails, the source may see an error and resend; the receiver
   absorbs the duplicate.

The time budget is 3 s plus about 0.3 s, under fumi's 5 s webhook timeout.

Each forward is logged with the source, the target, the status, a reason and the
age of `setAt`. Logs never contain headers, URL paths, secrets or message text.
Deduplication rows are kept for 7 days.

## Choosing the active target

`set_active(source, target, leaseUnix)` is an MCP tool.

- **Who calls it.** Only a Grok scheduled run on the active account calls it,
  passing its own target and the unix time of its lease. Webhook-started runs and
  inactive accounts never call it.
- **What the relay accepts.** It refuses a `leaseUnix` older than the stored one,
  so two accounts cannot flip the route back and forth, and a target that the
  route does not list. At an equal `leaseUnix` it refuses a different target. It
  also refuses a `leaseUnix` more than 5 minutes in the future, since the lease
  time is when the lease was recorded and a future one would block the real
  holder until then.
- **Staleness.** Nothing switches automatically. Every forward logs the age of
  `setAt`, and a daily agent check compares the relay's active target with the
  owner's own record of the active account. The agent may read git; the relay
  does not.
- **A switch during a delivery.** A forward that ends `unknown` is resent to the
  new target, so both accounts may handle the same mail. The receiver's "already
  handled" check reads fumi, not anything local to one account.

## MCP endpoint

The Worker serves one Custom Domain, `tayori.takuk.me` (owner, 2026-11-22
15:09 UTC: one host with a path bypass, as for Suguri's WebSub callback, instead
of a separate MCP host):

- An Access app covers the whole host, so **`/mcp`** is owner-only. The Worker
  also checks the Access JWT itself, as fumi does: issuer, audience,
  `type: "app"`, RS256 and the principal allowlist.
- A more specific Access app bypasses **`/in/*`**, which is checked by signature
  instead. No other Access app may cover it.

Every other host or path returns 404. `workers.dev` and preview URLs are off.

| Tool                                    | What it does                           | Returns                                                   |
| --------------------------------------- | -------------------------------------- | --------------------------------------------------------- |
| `set_active(source, target, leaseUnix)` | Sets the active target of a `one` route | `{source, active, leaseUnix, setAt}` or a refusal reason |
| `get_routes()`                          | Lists each route and target            | Active target, `setAt` and age, each target's host and last delivery status; never a URL path or key |

All Portal clients share one owner principal. An injected `set_active` call can
only choose another target that the route already lists; that shows in the log
and in the daily check. Each call is logged with `X-Forwarded-User-Agent`, for
audit only.

## Later, when a real need exists

- `mode: "all"`, deduplicating on (`source`, `webhook-id`, `target`).
- Failover to the next target after repeated 429 or 401, never on timeouts. It
  stays off for Grok.
- `standard-webhooks` and `none` target authentication.
