# Design

Tayori is a signed webhook relay on Cloudflare Workers. A source POSTs a signed
delivery, or an agent fires an `mcp` source through MCP; the relay verifies it,
deduplicates it and forwards it to the target that is active for that source's
route. The name comes from _tayori_ (便り, a letter or news).

Status: the request path, the Relay Durable Object and the MCP tools are implemented
with synthetic tests (`fire` added 2026-11-28) and deployed on `tayori.takuk.me` behind
Access (2026-11-23). The Portal registration and the targets are not done yet; see
[the roadmap](roadmap.md).

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
- Agents wake each other through tayori: an `mcp` source is fired with the MCP
  tool `fire`, and what can be fired and where it goes stays in this reviewed
  configuration, never in the call. The first two are `to-claude` (a claude.ai
  Project routine) and `to-grok` (the active account's desk automation, separate
  from fumi's inbox receiver). The message itself stays in techo `bin/w handoff`;
  tayori carries only the handoff id (owner, 2026-11-28 07:28, 07:38 and 07:39
  UTC, after an independent review of the proposal).
- fumi's targets are named after the bot that receives them, `grok-a-inbox` and
  `grok-b-inbox`, like the `-desk` targets (owner, 2026-11-28 08:54 UTC).
- The `fire` limits are raised from 6 an hour and 20 a day to 12 and 50 for
  `to-claude`, and from 2 and 6 to 4 and 15 for `to-grok`, because the owner
  expects the earlier limits to run out (owner, 2026-11-28 10:52 UTC). This is
  the owner's estimate, not measured fire demand: on 2026-11-24 Claude wrote 30
  handoffs in techo, all `[fyi]`, and senders fire only for urgent ones.

## Words used here

- **Source**: a sender. A `webhook` source POSTs into `/in/<source>`, for example
  `fumi`; an `mcp` source is fired through the MCP tool `fire`, for example
  `to-claude`. Each source has exactly one route, named after the source.
- **Target**: a URL the relay forwards to, for example `grok-b-inbox`.
- **Route**: which targets a source's deliveries go to, and how. The first build
  has only `one`: a single active target.
- **Active target**: for a `one` route, the target used right now.

## Configuration

Deployed configuration, changed only through a reviewed PR:

```jsonc
{
  "sources": {
    "fumi": { "kind": "webhook", "secret": "SOURCE_FUMI_SECRET", "bodyCheck": "fumi-notification" },
    "to-claude": { "kind": "mcp", "payload": "handoff-id", "limit": { "perHour": 12, "perDay": 50 } },
    "to-grok": { "kind": "mcp", "payload": "handoff-id", "limit": { "perHour": 4, "perDay": 15 } }
  },
  "targets": {
    "grok-a-inbox": { "auth": "bearer", "secret": "TARGET_GROK_A_INBOX" },
    "grok-b-inbox": { "auth": "bearer", "secret": "TARGET_GROK_B_INBOX" },
    "grok-a-desk": { "auth": "bearer", "secret": "TARGET_GROK_A_DESK" },
    "grok-b-desk": { "auth": "bearer", "secret": "TARGET_GROK_B_DESK" },
    "claude": { "auth": "claude-routine", "secret": "TARGET_CLAUDE", "timeoutMs": 10000 }
  },
  "routes": {
    "fumi": { "mode": "one", "targets": ["grok-a-inbox", "grok-b-inbox"] },
    "to-claude": { "mode": "one", "targets": ["claude"] },
    "to-grok": { "mode": "one", "targets": ["grok-a-desk", "grok-b-desk"] }
  }
}
```

- Each Grok account runs its bot as a Cursor automation, so a Grok target is
  that automation's webhook trigger.

- `TARGET_GROK_A_INBOX` and `TARGET_GROK_B_INBOX` are Worker secrets holding
  `{"url":"https://api2.cursor.sh/automations/webhook/<id>","key":"crsr_…"}`.
  The target is called with `Authorization: Bearer <key>`. No URL or key is kept
  in a repository, a chat or a log.

- `TARGET_GROK_A_DESK` and `TARGET_GROK_B_DESK` have the same shape, for each
  account's desk automation, which receives `to-grok`.

- `TARGET_CLAUDE` holds
  `{"url":"https://api.anthropic.com/v1/claude_code/routines/trig_<id>/fire","key":"sk-ant-oat01-…"}`
  for the claude.ai routine that receives `to-claude`. The routine's token only fires
  that routine (owner, 2026-11-28 07:36 UTC). A `claude-routine` target must use host
  `api.anthropic.com` with no port or query and that path.

- `SOURCE_FUMI_SECRET` is the Standard Webhooks secret that fumi signs with.

- `ACCESS_ISSUER`, `ACCESS_AUDIENCE` and `ALLOWED_PRINCIPALS` guard `/mcp`.
  `ALLOWED_PRINCIPALS` is a JSON array such as `["user:<sub>"]`.

- Every secret is optional at deploy. Until one is set, the part that needs it
  answers 503 and nothing is forwarded.

- Runtime state lives only in a Durable Object, for example:

  ```jsonc
  { "route": "fumi", "active": "grok-b-inbox", "leaseUnix": 1795196087, "setAt": "2026-11-21T17:34:12Z" }
  ```

- A deploy never changes the active target. A `one` route with no active target
  answers 503, so the source retries. A `one` route that lists exactly one target
  uses it without an active-target row.

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

## Firing an `mcp` source

`fire(source, handoffId)` is an MCP tool. `handoffId` is a techo handoff id
matching `^[a-z0-9][a-z0-9-]{0,31}-[0-9]{8}-[0-9]{3,4}$`, such as
`claude-20261128-001`; no other input is accepted.

1. **Check.** The source must be a configured `mcp` source; `/in/<source>`
   answers 404 for one, and `fire` answers `unknown_source` for a `webhook`
   source.
2. **Deduplicate** on (`source`, `mcp_<handoffId>`) in the same table:
   - `forwarded`: answer `already_forwarded` with the first send time;
   - `sending` inside its lock: answer `unavailable`;
   - `unknown`, or `sending` past its lock: answer `unknown`. No receiver has an
     idempotency key, so a send that may have arrived is never repeated; a missed
     wake is picked up by the receiver's scheduled check, while a repeat would
     start a second session.
3. **Limit.** Sends in the rolling hour and day are counted in a `fires` table.
   Over either limit, answer `rate_limited`. The slot and the `sending` row are
   written in one synchronous block before the send, so concurrent fires cannot
   both pass; a `cleared` outcome gives the slot back.
4. **Send** inside the Durable Object, under `ctx.waitUntil` in the MCP handler,
   with a body the Relay builds:
   - `bearer`: `{"source":"to-grok","handoffId":"claude-20261128-001"}` with the
     `webhook-id` header `mcp_<handoffId>`;
   - `claude-routine`: `{}` with `anthropic-version: 2023-06-01` and
     `anthropic-beta: experimental-cc-routine-2026-04-01`, and no `webhook-id`. A
     Project routine answers a body with `text` with 403 "this project is paused"
     (anthropics/claude-code
     [#102874](https://github.com/anthropics/claude-code/issues/102874) and
     [#112401](https://github.com/anthropics/claude-code/issues/112401)), while `{}`
     opened a new Project thread (2026-11-28 06:29 UTC). The receiver reads its handoffs
     from techo.
   - The timeout is the target's `timeoutMs` (10 s for `claude`), else 3 s.
5. **Answer.** `forwarded`, or `unknown` for a timeout or a failed call into the
   Relay (it may have sent already), or `unavailable` for any cleared outcome.
   Responses are classified as for `/in/`.

Each fire is logged with the principal, user agent, source, handoff id and
outcome, never headers, URL paths, keys or message text.

What an injected Portal client can do with `fire`: wake one of the configured
receivers up to its limit (about 0.73 % of Grok's weekly limit per `to-grok` wake, so
about 11 % a day at the daily limit and about 77 % over a week, a limit that every
Grok bot on the account shares; up to 50 Claude Project sessions a day for
`to-claude`), use up a limit so real wakes get `rate_limited`, or fire a predictable
future handoff id first, so the real `fire` gets `already_forwarded` with an early
`firstAt`. It cannot choose a URL, credential, body or unlisted route. In each case
the wake is lost or delayed, not misdirected, and the receivers' scheduled checks
still read the handoff.

## Choosing the active target

`set_active(source, target, leaseUnix)` is an MCP tool.

- **Who calls it.** Only a Grok scheduled run on the active account calls it,
  passing its own target and the unix time of its lease, once for `fumi` and once
  for `to-grok` with its desk target. Webhook-started runs and
  inactive accounts never call it.
- **What the relay accepts.** It refuses a `leaseUnix` older than the stored one,
  so two accounts cannot flip the route back and forth, and a target that the
  route does not list. At an equal `leaseUnix` it refuses a different target. It
  also refuses a `leaseUnix` more than 5 minutes in the future, since the lease
  time is when the lease was recorded and a future one would block the real
  holder until then.
- **Staleness.** Nothing switches automatically. Every forward logs the age of `setAt`,
  and a daily agent check compares the relay's active targets (`fumi` and `to-grok`)
  with the owner's own record of the active account. The agent may read git; the relay
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
| `get_routes()`                          | Lists each route and target            | Active target, `setAt` and age, each target's host and last delivery status, and for `mcp` sources the sends left this hour and day and the last `rate_limited`; never a URL path or key |
| `fire(source, handoffId)`               | Wakes an `mcp` source's receiver once per handoff id | `{status: "forwarded"}`, `{status: "already_forwarded", firstAt}`, or an error code: `invalid_arguments`, `unknown_source`, `rate_limited`, `unavailable`, `unknown` |

All Portal clients share one owner principal. An injected `set_active` call can
only choose another target that the route already lists; that shows in the log
and in the daily check. Each call is logged with `X-Forwarded-User-Agent`, for
audit only.

## Deployment

Every main commit whose checks pass deploys through the shared deploy action
with the versions strategy and `deploy-triggers: true`, so CI also owns the
Custom Domain, as risu729/infra's application domain delivery expects. The
`production` Environment's `CLOUDFLARE_API_TOKEN` has Individual Workers Editor
on `tayori` and Workers Routes Write on `takuk.me`; its metadata lives in infra.

The Worker was created once through the Cloudflare API as a placeholder that returns
404, with the `Relay` SQLite class migration, so the token could be scoped to it (owner
approval, 2026-11-22 15:16 UTC). The domain was not attached by hand. The first Deploy
Worker run (2026-11-23 02:33 UTC) stopped because `cf workers versions create` in CI
refuses to replace a Worker last updated through the script API. A temporary `Bootstrap`
workflow replaced it once with `cf deploy --force`
([run 45101831603](https://github.com/risu729/tayori/actions/runs/45101831603), 02:45
UTC), which also attached the Custom Domain; the normal job then deployed (run
45102502321) and the workflow was removed. Setting Worker secrets through the API keeps
the `cf_cli` source, so later deploys are unaffected.

## Later, when a real need exists

- `mode: "all"`, deduplicating on (`source`, `webhook-id`, `target`).
- Failover to the next target after repeated 429 or 401, never on timeouts. It
  stays off for Grok.
- `standard-webhooks` and `none` target authentication.
