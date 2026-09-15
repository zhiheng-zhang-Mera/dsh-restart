# Protocol

The shared protocol module (`src/shared/protocol.ts`) **is the contract**. It names the shapes both sides agree on and says nothing about how a restart is performed, so a requester — the health scheduler, an operator script, a test rig — can be written against this document alone, without importing the implementation.

Everything here crosses a process or a file boundary: a request and its response over the plugin's API, a ticket from the plugin to the supervisor, a heartbeat and a ledger from the supervisor back to the plugin. A requester needs only the four entry points the design names — `requestApplicationRestart(request)`, `requestSystemRestart(request)`, `getRestartStatus()`, `cancelPendingRestart(requestId)` — plus the shapes below. See also [README](../README.md) · [architecture.md](architecture.md) · [operations.md](operations.md) · [failure-modes.md](failure-modes.md). Where the design document disagrees with the source, this document follows the source and says so in a *Divergence* note.

## 1. RestartRequest

```ts
type RestartMode = 'application' | 'system'
type RestartPriority = 'low' | 'normal' | 'high' | 'emergency'
type RestartReasonCode = 'RUNTIME_PRESSURE' | 'SYSTEM_PRESSURE' | 'MEMORY_LEAK' | 'THERMAL_STRESS' | 'UI_DEGRADATION'
  | 'COMPUTER_USE_STALL' | 'SCHEDULED_MAINTENANCE' | 'OPERATOR_REQUEST' | 'TEST' | (string & {})  // open vocabulary

interface RestartRequest {
  readonly requestId: string               // requester-chosen and unique; de-duplication keys on this alone
  readonly source: string                  // requesting module id, e.g. 'dsh-health-scheduler'
  readonly mode: RestartMode
  readonly reasonCode: RestartReasonCode   // recorded, never interpreted
  readonly reasonSummary: string           // one line, recorded verbatim, never parsed
  readonly checkpointRequired: boolean     // a required checkpoint that cannot be confirmed aborts the restart
  readonly priority: RestartPriority       // a hint: it never bypasses validation
  readonly createdAt?: string              // ISO-8601 instant the requester created the request
  readonly acknowledgeSystemReboot?: boolean // consulted only for mode 'system'
}
```

`validateShape` normalises this into a `NormalizedRequest` in which every field is required: `priority` defaults to `'normal'`, `createdAt` to `new Date(0).toISOString()` (the epoch, `"1970-01-01T00:00:00.000Z"`) and `acknowledgeSystemReboot` to `false`. Shape validation runs before every policy check, so a malformed request never reaches the cooldown ledger, the duplicate map or the code that writes files.

```json
{ "requestId": "tool-1780000000000-482913", "source": "dsh-cli", "mode": "application",
  "reasonCode": "RUNTIME_PRESSURE",
  "reasonSummary": "pressure_84_gte_app_restart_80, memory_slope_high, maintenance_window_open",
  "checkpointRequired": true, "priority": "normal",
  "createdAt": "2026-06-01T09:05:00.000Z", "acknowledgeSystemReboot": false }
```

The request `dsh-health-scheduler` actually sends is this shape minus the two optional fields (captured: `requestId` `hs-1772297190000-1`, the same `reasonSummary`, `priority` `normal`).

<details>
<summary>Every shape-validation refusal, verbatim (<code>validateShape</code>)</summary>

| Field | Rule | Exact `detail` on failure |
| --- | --- | --- |
| the request | a non-null object; arrays and primitives are refused | `request must be an object, received <typeof value>` |
| `requestId` / `source` / `reasonCode` / `reasonSummary` | strings, non-empty after `trim()`, at most 128 / 64 / 64 / 500 characters, and no control characters `[\u0000-\u001f\u007f]` | `<field> must be a non-empty string` / `<field> exceeds <max> characters` / `<field> contains control characters` |
| `mode` | exactly `'application'` or `'system'` | `mode must be "application" or "system", received "partial"` |
| `checkpointRequired` | a real boolean — no truthy coercion | `checkpointRequired must be a boolean` |
| `priority` | `low`, `normal`, `high` or `emergency`; omitted means `normal` | `priority must be low, normal, high or emergency, received "urgent"` |
| `createdAt` | when present, a string | `createdAt must be an ISO-8601 string when present` |
| `acknowledgeSystemReboot` | when present, a boolean | `acknowledgeSystemReboot must be a boolean when present` |

Every string is **trimmed rather than rejected** (`"  dsh-health-scheduler  "` becomes `dsh-health-scheduler`), a number or object where a string is expected fails the same check as a missing field, and the bounds are log-injection bounds rather than business rules. `createdAt` is type-checked only: its content is never parsed, compared or used — it does not affect expiry (a ticket's `expiresAt` is the accept instant plus `supervisor.ticketTtlMs`) and it is not carried into the ticket.
</details>

**Divergence (design §10).** The design's `RestartRequest` is `{ requestId, mode, reasonCode, priority, checkpointRequired }` with `priority: "normal" | "high" | "emergency"`, and its JSON sketch uses snake_case keys (`request_id`, `reason_code`, `checkpoint_required`). The implementation **requires `source` and `reasonSummary`**, adds the optional `createdAt` and `acknowledgeSystemReboot`, uses camelCase on the wire, and its priority vocabulary **includes `low`** — the design's union lacks it while `DEFAULT_CONFIG.allowedPriorities` lists all four. Only the model-facing tool parameters are snake_case; that is a tool-call surface, not the protocol.

## 2. RestartResponse

```ts
type RestartRequestState = 'rejected' | 'queued' | 'checkpointing' | 'shutting_down' | 'relaunching'
  | 'verifying' | 'completed' | 'failed' | 'cancelled'

interface RestartResponse {
  readonly accepted: boolean   // whether the request was accepted and is (or was) being carried out
  readonly state: RestartRequestState
  readonly reason?: string     // machine-readable rejection or failure code; absent when accepted
  readonly detail: string      // human-readable explanation, safe to log and to show
  readonly requestId: string   // echoed so a caller can correlate
  readonly ticketId?: string   // present when a ticket was written
}
```

An accepted application restart, produced by the real pipeline:

```json
{ "accepted": true, "state": "shutting_down",
  "detail": "application restart accepted: the host is shutting down and the supervisor will relaunch it",
  "requestId": "tool-1780000000000-482913", "ticketId": "application-1780304700000-1-2dca85a9" }
```

A refusal raised before anything was written is the same shape minus `ticketId` — for example `reason: "SUPERVISOR_ABSENT"` with the detail `no supervisor heartbeat was seen; set safety.allowRestartWithoutSupervisor = true to restart anyway`. An abort after the ticket was written adds `ticketId` (the id it wrote, then deleted) to `state: "failed"`. For `mode: "system"` the accepted detail is `system restart accepted: the machine will reboot and the supervisor will relaunch DS-Hns`.

### Which states are actually produced, and where

| State | Produced by | Notes |
| --- | --- | --- |
| `rejected` | `refuse()`: shape failures, policy failures, a replayed id with different content, an illegal lock edge | `reason` is a code from the table below; no ticket exists |
| `shutting_down` | the accepted response, after the ticket is written and the host accepted the shutdown request | the only success state a caller ever sees |
| `failed` | `abort()`: an aborted checkpoint, a ticket write failure, a refused or throwing shutdown port | the ticket is deleted and the lock released before the answer is returned |
| `queued` | never returned. The in-flight request starts here and it is visible as `status.active.state` | `RestartLock` maps `REQUESTED → 'queued'` |
| `checkpointing` | never returned. Visible as `status.active.state` while the gate runs | `RestartLock` maps `CHECKPOINTING → 'checkpointing'` |
| `cancelled` | never returned. It is an **audit** state: `cancelPendingRestart()` returns a bare boolean, and `restart_cancel` returns `{ "cancelled": …, "detail": … }` | the audit record is written with `state: 'cancelled'`, `outcomeCode: 'CANCELLED'` |
| `relaunching` | never produced: the plugin never observes the relaunch, it is expected to be gone | the lock declares it and `cancelPendingRestart()` guards on it; nothing sets it |
| `verifying` | never produced, as above | — |
| `completed` | never produced; it is the `RestartLock` projection of `IDLE` | the outcome surfaces in the audit log and the next process's reconciliation |

Under `rejected` the codes are `INVALID_REQUEST` (a shape failure, or a `priority` valid but not in `allowedPriorities`: `priority normal is not accepted by this deployment`), `DISABLED`, `UNKNOWN_SOURCE`, `MODE_NOT_ALLOWED`, `SYSTEM_REBOOT_NOT_PERMITTED`, `CRASH_LOOP`, `DUPLICATE_REQUEST_ID` (the id reused for **different** content), `RESTART_IN_FLIGHT` (the lock is not `IDLE`; if `transition('REQUESTED')` is refused instead, the detail is the lock's `illegal restart lock transition …; allowed: …`), `COOLDOWN_ACTIVE` (the detail reports the remaining seconds, rounded up, and the minimum interval), `CHECKPOINT_FAILED` (no checkpoint port bound **and** `safety.checkpointRequired` true, a policy refusal before any execution) and `SUPERVISOR_ABSENT`. Under `failed` they are `CHECKPOINT_FAILED` (the port threw, or answered `safe: true` with `completed: false`), `CHECKPOINT_REQUIRED` (the harness reported `safe: false`, e.g. `git_commit_in_progress`), `TICKET_WRITE_FAILED` (`restart aborted: could not write the restart ticket (<message>)`) and `SHUTDOWN_PORT_UNAVAILABLE`. So `CHECKPOINT_FAILED` appears in **two states**: read `state`, not just `reason`.

The gate is `authorized = checkpointRequired ? (outcome.safe && outcome.completed) : true`, with `safety.shutdownTimeoutMs` (90 s) as its budget: with `checkpointRequired: false` the restart proceeds even when the port throws or answers unsafe, and a port that never answers is abandoned rather than hanging the lock.

`reason` is a `string`, not a closed union: branch on known codes and treat an unknown one as "refused or aborted, read `detail`". Every policy refusal, abort and acceptance is remembered against its `requestId` (the 200 most recent, in memory only), so an identical replay returns the **first response verbatim**, including its original `ticketId`. The plugin's own codes are in [§9](#9-self_reason_codes); the refusal details are tabulated in the [README](../README.md#every-refusal-code).

**Divergence (design §10).** The design's union is `rejected | queued | checkpointing | restarting | verifying | completed | failed`, and its interface has only `accepted`, `state` and an optional `reason`. The implementation has **no `restarting`**: the two states it names are `shutting_down` (the accepted answer) and `relaunching` (declared, never reached). It adds `cancelled` and the three fields `detail`, `requestId` and `ticketId`. Read `restarting` as `shutting_down` when a response is involved.

## 3. RestartStatus

`getRestartStatus()` returns the whole picture; `statusPayload()` projects it onto the snake_case names the tools print, and the tools return it as a JSON **string** (`JSON.stringify(payload, null, 2)`).

```ts
interface RestartStatus {
  readonly timestamp: string           // ISO-8601 instant the status was read
  readonly enabled: boolean            // config.enabled
  readonly lock: RestartLockState      // IDLE | REQUESTED | CHECKPOINTING | SHUTTING_DOWN | RELAUNCHING | VERIFYING
  readonly active: RestartActiveRequest | null
  readonly canRestart: { readonly allowed: boolean; readonly reason: string }
  readonly cooldowns: { readonly application: CooldownState; readonly system: CooldownState }
  readonly recent: readonly RestartAttemptRecord[]   // newest first, bounded by storage.maxRecentAttempts
  readonly crashLoop: CrashLoopState
  readonly supervisor: SupervisorPresence
  readonly capabilities: { readonly applicationRestart: boolean; readonly systemRestart: boolean
    readonly checkpointPort: boolean; readonly shutdownPort: boolean; readonly supervisorWatch: boolean }
}
```

Only three names are renamed by the projection; `timestamp`, `enabled`, `lock`, `active`, `cooldowns`, `supervisor`, `capabilities`, `recent` and everything nested (`crash_loop.tripped`, `cooldowns.application.minimumIntervalMs`, `supervisor.lastSeenAt`, `capabilities.applicationRestart`, `recent[].outcomeCode`) keep their camelCase names.

| `RestartStatus` | Tool payload (`statusPayload()`) |
| --- | --- |
| `canRestart.allowed` | `can_restart` |
| `canRestart.reason` | `can_restart_reason` |
| `crashLoop` | `crash_loop` |

A real payload from a fresh process with a live heartbeat and a bound checkpoint port (wrapped for width; the tool prints the fully expanded form). After an accepted restart, `lock` is `SHUTTING_DOWN`, `can_restart` is `false` with `can_restart_reason` `RESTART_IN_FLIGHT`, `active` holds the request in state `shutting_down`, the mode's cooldown is filled in, and `recent[0]` is the accepted attempt:

```json
{
  "timestamp": "2026-06-01T09:05:00.000Z", "enabled": true, "lock": "IDLE",
  "can_restart": true, "can_restart_reason": "OK", "active": null,
  "cooldowns": { "application": { "nextAllowedAt": null, "remainingMs": 0, "minimumIntervalMs": 1200000 },
    "system": { "nextAllowedAt": null, "remainingMs": 0, "minimumIntervalMs": 3600000 } },
  "crash_loop": { "tripped": false, "failuresInWindow": 0, "limit": 3, "windowMs": 600000, "trippedAt": null, "reason": null },
  "supervisor": { "present": true, "lastSeenAt": "2026-06-01T09:05:00.000Z", "ageMs": 0 },
  "capabilities": { "applicationRestart": true, "systemRestart": false, "checkpointPort": true, "shutdownPort": true, "supervisorWatch": true },
  "recent": []
}
```

<details>
<summary>What each field means, including the fields that do not mean what they look like</summary>

| Field | Meaning |
| --- | --- |
| `active` | the in-flight request: `requestId`, `ticketId`, `source`, `mode`, `reasonCode`, `priority`, `state`, `createdAt`, `updatedAt`, `attempts` (which becomes 1 only once the host accepted the shutdown) |
| `canRestart.reason` | the first applicable of, in order: `DISABLED`, `CRASH_LOOP`, `RESTART_IN_FLIGHT`, `MODE_NOT_ALLOWED`, `COOLDOWN_ACTIVE`, `SUPERVISOR_ABSENT`, `CHECKPOINT_FAILED`, else `OK`; it describes the **application** mode |
| `cooldowns.<mode>` | `nextAllowedAt` (deadline or `null`), `remainingMs` (`max(0, deadline - now)`), `minimumIntervalMs` (20 min application, 60 min system by default) |
| `recent[]` | newest first, in memory only, bounded by `storage.maxRecentAttempts` (25); refusals are recorded too, `clean` is always `true` in this release, and `outcomeCode` is a refusal code or `ACCEPTED` / `CANCELLED` |
| `crashLoop` | the **plugin-side** breaker: `tripped` is set only by `tripCrashLoop()` and is not read from `ledger.json`, and `failuresInWindow` is **not a measurement** (`crashLoopLimit` while tripped, `0` otherwise) |
| `supervisor` | `present` is heartbeat age ≤ `supervisor.heartbeatTimeoutMs` (see [§5](#5-the-heartbeat)); `lastSeenAt` is the `timestamp` the supervisor wrote, verbatim, or `null`; `ageMs` is its age, clamped at ≥ 0, or `null` with no heartbeat at all |
| `capabilities` | `applicationRestart` = `applicationRestart.enabled`; `systemRestart` = `systemRestart.enabled` **and** `allowSystemReboot` **and** a system-shutdown port bound; `checkpointPort` = a real checkpoint port is bound; `shutdownPort` and `supervisorWatch` are **hard-coded `true`** — "a port is wired" and "the plugin watches for a supervisor" — so use `supervisor.present` for liveness |

After an accepted restart the lock stays `SHUTTING_DOWN` for the rest of that process's life (it is the process being asked to exit), and cooldown deadlines live only in the process that accepted the restart.
</details>

## 4. The ticket document

The ticket is the only document that crosses from the plugin to the supervisor, and the supervisor treats anything that does not verify as a hazard rather than a hint.

```ts
const TICKET_SCHEMA_VERSION = 1

interface RestartTicket {
  readonly schemaVersion: number        // must equal TICKET_SCHEMA_VERSION
  readonly ticketId: string             // `${mode}-${nowMs}-${sequence}-${uuid8}`
  readonly requestId: string            // the requester's id, for correlation
  readonly mode: RestartMode
  readonly reasonCode: string
  readonly reasonSummary: string
  readonly pid: number                  // the pid the supervisor should watch
  readonly createdAt: string            // ISO-8601, the accept instant
  readonly expiresAt: string            // ISO-8601; nowMs + supervisor.ticketTtlMs (600000 by default)
  readonly cleanShutdown: boolean       // true for every ticket this pipeline writes
  readonly checkpointId: string | null  // the checkpoint the restart was authorised against
  readonly checksum: string             // 'sha256:<hex>' over the canonical JSON of every other field
}
```

The id is `${mode}-${nowMs}-${sequence}-${uuid8}`: the mode, the accept instant in epoch milliseconds, a per-process monotonic sequence starting at 1, and the first 8 hex characters of a random UUID v4 — for example `application-1780304400000-1-e2efb725` or `application-1780304700000-1-2dca85a9`. A real `ticket.json`:

```json
{ "schemaVersion": 1, "ticketId": "application-1780304700000-1-2dca85a9",
  "requestId": "tool-1780000000000-482913", "mode": "application", "reasonCode": "RUNTIME_PRESSURE",
  "reasonSummary": "pressure_84_gte_app_restart_80, memory_slope_high, maintenance_window_open",
  "pid": 4242, "createdAt": "2026-06-01T09:05:00.000Z", "expiresAt": "2026-06-01T09:15:00.000Z",
  "cleanShutdown": true, "checkpointId": "ck-1",
  "checksum": "sha256:3d0867bab9563554e342324221c093e16ab2c111b2df1005aac66d9209f1cd8f" }
```

**Canonical JSON** (`canonicalJson(value)`): primitives through `JSON.stringify`, with `undefined` becoming the literal `null`; arrays element-wise with order preserved (`canonicalJson({ a: [1, { d: 4, c: 3 }] })` is `{"a":[1,{"c":3,"d":4}]}`); objects with keys sorted ascending, entries whose value is `undefined` **dropped**, `null` preserved (`canonicalJson({ a: 1, b: undefined })` is `{"a":1}`). Key order in the file is therefore irrelevant and a checksum is reproducible.

**Checksum**: `sha256:<hex>` over the UTF-8 bytes of `canonicalJson` of every field **except `checksum` itself**. `verifyTicket` destructures `{ checksum, ...rest }` and recomputes over `rest`, so any field added, removed or edited after the fact changes the digest — and **adding a field to a ticket is a breaking change** that requires a `TICKET_SCHEMA_VERSION` bump. **Write**: `writeJsonAtomic` → sibling temp file, `fsync`, `rename` over `ticket.json`; two-space indentation, trailing newline, mode `0600`, so a hard kill leaves either the old document or the new one and no temporary file survives. The ticket is written only after the checkpoint gate has authorised the request, and `checkpointId` is the checkpoint the gate returned (`null` when the request did not require one).

### The six verification rejections

`verifyTicket(candidate, nowMs, expectedPid?)` returns `{ valid, ticket, rejection, detail }`. A rejection is never a repair, and the callers delete what does not verify. Only checks 1–5 fire in production, because **no production caller passes `expectedPid`**. In evaluation order:

| # | `rejection` | `detail` | What it means |
| --- | --- | --- | --- |
| 1 | `missing` | `no ticket file` | the candidate is `null`/`undefined`. `readJson` returns `null` for a missing file, an unreadable file **and unparsable JSON**, so a corrupt `ticket.json` also reads as *missing* |
| 2 | `malformed` | `ticket is not an object` | valid JSON that is not an object (`"a string"`, `42`, an array) |
| 3 | `schema_version` | `ticket schemaVersion 99 is not 1` | `schemaVersion !== TICKET_SCHEMA_VERSION`: the document is from another version |
| 4 | `checksum` | `ticket checksum does not match its contents` | `checksum` is not a string, or differs from the recomputed digest: a truncated, edited or tampered ticket |
| 5 | `expired` | `ticket expired at 2026-06-01T09:15:00.000Z` | `expiresAt <= nowMs`, or `expiresAt` is not a finite date; the clock is the reader's |
| 6 | `wrong_pid` | `ticket targets pid 4242, not 9999` | the caller supplied `expectedPid` and the ticket names a different process |

The supervisor reads the ticket without an expected pid and instead *adopts* the pid it names (`adopted_ticket_pid`, `now watching pid <pid> from ticket <ticketId>`), so `wrong_pid` is reachable only through a direct call, as the tests do. A ticket that does not verify is destroyed: the supervisor clears the file and logs `discarded_unverifiable_ticket` with `{ "rejection": "<one of the six>" }`, then keeps monitoring; the plugin's `reconcileAfterRestart()`, run once at startup, deletes any ticket it finds — this process just began, so a ticket can only be a leftover — and reports either `discarded a pending ticket from request <id> (written <createdAt>); the previous process did not exit` or `discarded an unusable ticket (<rejection>: <detail>)`.

The checksum is **integrity, not authentication**. There is no shared secret and no signature: the digest is computed over a public canonical form, so it detects a truncated or edited ticket but proves nothing about who wrote it. **Anything that can write the state directory can forge a ticket that verifies**, checksum, `pid` and `expiresAt` included. The directory's filesystem permissions are part of the trust model, not a detail.

## 5. The heartbeat

```ts
interface SupervisorHeartbeat {
  readonly schemaVersion: number   // always 1 as written by HeartbeatWriter
  readonly supervisorPid: number
  readonly watchedPid: number      // the process the supervisor believes it is watching
  readonly state: SupervisorState  // MONITORING | WAITING_FOR_EXIT | RELAUNCHING | WAITING_FOR_HEARTBEAT
                                   // | VERIFIED | CRASH_LOOP | SAFE_MODE | STOPPED
  readonly timestamp: string       // ISO-8601 instant the beat was written
  readonly sequence: number        // monotonic per writer process, starting at 1
}
```

A real `heartbeat.json`, written after a verified relaunch, and the rule the plugin applies to it:

```json
{ "schemaVersion": 1, "supervisorPid": 28868, "watchedPid": 10002,
  "state": "MONITORING", "timestamp": "2026-06-01T09:00:05.000Z", "sequence": 7 }
```

```text
ageMs      = now - Date.parse(heartbeat.timestamp)   // when that field is a parseable string
           = now - mtime(heartbeat.json)             // fallback: no heartbeat, or an unusable timestamp
present    = ageMs !== null && ageMs <= supervisor.heartbeatTimeoutMs
lastSeenAt = heartbeat.timestamp                     // the field, verbatim; null when the file is absent
```

Both ages are clamped at `max(0, …)`, so a timestamp from the future reads as age `0`, i.e. present. Defaults: the supervisor beats every `heartbeatIntervalMs` (5 s) and immediately on every state change and watched-pid change; `heartbeatTimeoutMs` is 30 s; the configuration refuses a timeout that does not exceed the interval (`dsh-restart config: supervisor.heartbeatTimeoutMs must exceed supervisor.heartbeatIntervalMs (60000), received 30000`).

**Correction to the research transcript.** The captured notes (and the README) describe `supervisor.ageMs` as the age of the heartbeat **file**, i.e. its mtime. The source does the opposite: `TicketStore.heartbeatAgeMs()` prefers the `timestamp` field the supervisor wrote and uses the file mtime **only as a fallback** when that field is missing or unparseable. The reading is the same for the case that matters — a supervisor that stopped beating leaves a file whose timestamp and mtime both stop advancing, so `present` goes `false` within `heartbeatTimeoutMs` and requests are refused with `SUPERVISOR_ABSENT` — but the two rules differ for a file whose mtime was touched while its timestamp stayed old: that reads as **absent**, not present.

## 6. The ledger

```ts
interface SupervisorLedger {
  readonly schemaVersion: number
  readonly uncleanStarts: readonly { readonly at: string; readonly reason: string }[]  // newest last
  readonly safeMode: boolean
  readonly safeModeReason: string | null
  readonly safeModeAt: string | null
  readonly relaunches: number
}
```

`emptyLedger()` returns exactly `{ schemaVersion: 1, uncleanStarts: [], safeMode: false, safeModeReason: null, safeModeAt: null, relaunches: 0 }`. A real `ledger.json`, after one clean application restart:

```json
{ "schemaVersion": 1, "uncleanStarts": [], "safeMode": false,
  "safeModeReason": null, "safeModeAt": null, "relaunches": 1 }
```

The reader is deliberately tolerant: a ledger that cannot be read must not stop a supervisor from supervising. Each field is coerced independently and the file is never rewritten or repaired.

| Condition | Result |
| --- | --- |
| file missing, unreadable, unparsable, or not an object | `emptyLedger()` |
| `schemaVersion` not a number | `1` |
| `uncleanStarts` not an array | `[]` (entries are used as-is; the breaker drops those whose `at` does not parse) |
| `safeMode` not exactly `true` | `false` |
| `safeModeReason` / `safeModeAt` not a string | `null` |
| `relaunches` not a number | `0` |

The supervisor writes it through the same atomic writer and restores a tripped breaker from it at startup: `safeMode: true` means automation stays off until an operator clears the flag (see [operations.md](operations.md)).

**The BOM trap.** `JSON.parse` rejects a leading UTF-8 BOM, `readJson` swallows the error and returns `null`, and `readLedger` therefore hands back an **empty ledger**. Verified against the real reader: the captured safe-mode ledger written with a BOM reads back as `safeMode: false, relaunches: 0`; written BOM-free it reads back as `safeMode: true, relaunches: 2`. A BOM silently re-arms automatic restart instead of reporting a problem, which is why both writers stay BOM-free: `writeJsonAtomic` writes plain UTF-8, and `scripts/*.ps1` use `[System.IO.File]::WriteAllText($Path, $json, (New-Object System.Text.UTF8Encoding($false)))`, with the inline comment "a BOM makes the file unparseable by the supervisor's reader". The plugin never reads `ledger.json` itself; safe mode is the supervisor's, and the plugin's `CRASH_LOOP` refusal comes from `tripCrashLoop()` instead.

## 7. Versioning rules

| Constant | Value | Scope | Rule |
| --- | --- | --- | --- |
| `PROTOCOL_VERSION` | `1` | the shapes in this document | bump **only** for a breaking change. It is exported from the package entry point and compared by nobody at runtime: there is no negotiation and no version field on a request, so assert it at build time |
| `TICKET_SCHEMA_VERSION` | `1` | per document, carried in every ticket | a ticket whose `schemaVersion` differs is **rejected, never migrated** (`rejection: 'schema_version'`, `ticket schemaVersion N is not 1`); the supervisor deletes it, logs `discarded_unverifiable_ticket`, and the next process clears it at startup |
| heartbeat `schemaVersion` | `1` | per document | written by `HeartbeatWriter`; the reader does not check it today |
| audit `schemaVersion` / `kind` | `1` / `'restart-attempt'` | per line in `restart-attempts.jsonl` | `readPersisted()` ignores a line whose version or kind differs; a half-written trailing line after a hard kill is skipped |

Adding a field to a ticket is a **breaking** change, not an additive one: the checksum covers every field present, so a newer ticket fails an older reader's `checksum` check unless the schema version is bumped to gate it.

**Unknown `reasonCode`.** `RestartReasonCode` is an open union (`… | (string & {})`) and validation checks only that the code is a non-empty string of at most 64 characters with no control characters. A new code needs no protocol change and no configuration change, and is stored verbatim in the ticket and the audit record. Be precise about `config.knownReasonCodes`, though: **nothing compares a request's `reasonCode` against it.** The list (nine codes by default) is read in exactly one place — to render the `restart_request` tool's description from its first six entries plus `…`. Its doc comment's "unknown codes are logged, not refused" is half true: an unknown code is certainly not refused, and it is not logged by name either — it is simply carried into the ticket and the audit record.

**How a requester should handle an unknown `reason`.** Branch on `state` first (`accepted`, then `rejected` / `failed`), then treat `reason` as an opaque string: the codes in [§9](#9-self_reason_codes) are the plugin's own, `SELF_REASON_CODES` maps each to an operator sentence, and any code outside that map must be reported with its `detail` verbatim rather than interpreted or retried blindly. `reason` is typed `string` on purpose — a new refusal code is not a protocol break, and a requester that switches without a default branch will break on one.

## 8. A worked round trip

One application restart, from `requestId` to relaunch, using captured values.

1. **Request.** An allowed source submits the body of §1 with `requestId: "tool-1780000000000-482913"`, `mode: "application"`, `checkpointRequired: true`. The deployment is the shipped default: `applicationRestart.enabled` true with `minIntervalMs` 1200000, `safety.checkpointRequired` true, and a supervisor heartbeat 0 ms old.
2. **Validation, lock, checkpoint.** `validateShape` accepts and trims, `validateRequest` finds no refusal, and the duplicate map has no entry for the id. `RestartLock` moves `IDLE → REQUESTED` with the request id as holder; the active request state becomes `queued`, then `CHECKPOINTING` / `checkpointing`. The gate asks the bound port, which answers `safe: true, completed: true, checkpointId: 'ck-1'`, so the restart is authorised and the ticket will cite that checkpoint.
3. **Ticket id and ticket.** With `nowMs = 1780304700000` (2026-06-01T09:05:00.000Z) and the process's first ticket, the id is `application-1780304700000-1-2dca85a9` from `${mode}-${nowMs}-${sequence}-${uuid8}`; the captured supervisor log shows the same format from another run, `application-1780304400000-1-e2efb725`. `buildTicket` writes the document of [§4](#4-the-ticket-document): schema version 1, `pid` 4242, `createdAt` 09:05:00.000Z, `expiresAt` 09:15:00.000Z (the 600000 ms TTL), `cleanShutdown: true`, `checkpointId: "ck-1"` and the matching `sha256:` checksum. A supervisor tick that finds it logs `restart_ticket_accepted`.
4. **Shutdown request, then accepted.** The lock moves to `SHUTTING_DOWN`, the active state becomes `shutting_down`, and the plugin calls `shutdown.requestShutdown(ticketId)` — the ticket id **is** the shutdown reason. The captured lifecycle recorded exactly one request: `["application-1780304700000-1-2dca85a9"]`; a host that refused, or a port that threw, yields the `failed` response of §2 with the ticket already deleted. The plugin then sets the mode's cooldown to `nowMs + minIntervalMs` (`nextAllowedAt: "2026-06-01T09:25:00.000Z"`), writes the audit record — `outcomeCode: "ACCEPTED"`, `clean: true`, detail `application restart accepted: the host is shutting down and the supervisor will relaunch it (checkpoint ck-1, reason RUNTIME_PRESSURE)` — and only then answers accepted with `state: "shutting_down"` and the ticket id. Nothing is awaited after this: awaiting its own exit is how a restart service deadlocks itself.
5. **Process boundary — the supervisor.** The captured `supervisor.log` of the equivalent scenario, in order, verbatim:
   ```text
   {"timestamp":"2026-06-01T09:00:05.000Z","state":"MONITORING","code":"supervisor_started","message":"watching pid 4242","detail":{"supervisorPid":28868,"directory":"D:\\DS-Hns\\temp\\docs-sup-ok-lc9Gu6"}}
   {"timestamp":"2026-06-01T09:00:05.000Z","state":"WAITING_FOR_EXIT","code":"restart_ticket_accepted","message":"restart_ticket_accepted","detail":{"ticketId":"application-1780304400000-1-e2efb725","mode":"application","pid":4242}}
   {"timestamp":"2026-06-01T09:00:05.000Z","state":"RELAUNCHING","code":"relaunching","message":"relaunching","detail":{"reason":"expected_exit_observed"}}
   {"timestamp":"2026-06-01T09:00:05.000Z","state":"WAITING_FOR_HEARTBEAT","code":"relaunched","message":"relaunched","detail":{"pid":10002}}
   {"timestamp":"2026-06-01T09:00:05.000Z","state":"VERIFIED","code":"relaunch_verified","message":"relaunch_verified","detail":{"pid":10002}}
   {"timestamp":"2026-06-01T09:00:05.000Z","state":"MONITORING","code":"monitoring_resumed","message":"monitoring_resumed","detail":{"pid":10002}}
   ```
   The supervisor verified the ticket, waited for the watched pid to disappear, cleared the ticket, relaunched and resumed monitoring. The run ended with `{"state":"MONITORING","reason":"TICK_LIMIT","relaunches":1,"safeMode":false}` and exit code `0`.
6. **Heartbeat, ledger, and the next start.** The result is visible to the plugin through the documents of [§5](#5-the-heartbeat) and [§6](#6-the-ledger): `heartbeat.json` with `supervisorPid` 28868, `watchedPid` 10002, `state` `MONITORING`, `timestamp` 09:00:05.000Z and `sequence` 7; and `ledger.json` with an empty `uncleanStarts`, `safeMode: false` and `relaunches: 1`. Had the process *not* exited, its ticket would still be on disk, and the next process's `reconcileAfterRestart()` would delete it and report `discarded a pending ticket from request tool-1780000000000-482913 (written 2026-06-01T09:05:00.000Z); the previous process did not exit`.

<details>
<summary>Provenance of every string above</summary>

- Steps 1–4 come from a run of the real pipeline against a real state directory (`RestartManager` and `TicketStore` from `lib/`, shipped defaults, a bound checkpoint port answering `ck-1`, a recording host lifecycle, pid 4242, clock fixed at `2026-06-01T09:05:00.000Z`). The checksum was recomputed independently from the canonical string and matches.
- Step 5 and the documents in step 6 are the captured scenario A log, heartbeat and ledger verbatim. That capture is a different run of the same scenario, so its ticket id carries another accept instant and random suffix (`application-1780304400000-1-e2efb725`) and its timestamps are 09:00:05 rather than 09:05:00. `pid: 4242` is the harness pid used by both captures; `10002` is the pid the supervisor relaunched.
</details>

## 9. SELF_REASON_CODES

The plugin's own reason codes and the operator sentence each maps to. The frozen, exported map is a requester's lookup table and documentation, not a validation table: the code paths pass plain string literals to `refuse()`.

| Code | Message |
| --- | --- |
| `DUPLICATE_REQUEST_ID` | a request with this id has already been processed |
| `UNKNOWN_SOURCE` | the requesting source is not in the allow list |
| `MODE_NOT_ALLOWED` | this restart mode is disabled by configuration |
| `SYSTEM_REBOOT_NOT_PERMITTED` | system restart requires an explicit permission and acknowledgement |
| `RESTART_IN_FLIGHT` | another restart is already in progress |
| `COOLDOWN_ACTIVE` | the minimum interval for this restart mode has not elapsed |
| `CHECKPOINT_REQUIRED` | this request requires a checkpoint and none was produced |
| `CHECKPOINT_FAILED` | the harness refused to prepare a checkpoint |
| `SHUTDOWN_TIMEOUT` | the process did not exit inside the shutdown budget |
| `SHUTDOWN_PORT_UNAVAILABLE` | no shutdown capability is bound, so a graceful restart is impossible |
| `SUPERVISOR_ABSENT` | no supervisor heartbeat was seen, so a restart could not be observed |
| `CRASH_LOOP` | the crash-loop breaker has disabled automatic restart |
| `INVALID_REQUEST` | the request did not satisfy the protocol |
| `DISABLED` | restart execution is disabled by configuration |

<details>
<summary>What is <em>not</em> in the map, and one entry no code path raises</summary>

- **`TICKET_WRITE_FAILED` is not in the map.** It *is* produced: `RestartManager.abort()` returns it as a `reason` (state `failed`) and records it as an `outcomeCode`. A requester that only looks codes up in `SELF_REASON_CODES` misses it — and the lock's own `RESTART_IN_FLIGHT` detail (`illegal restart lock transition …; allowed: …`) is a second sentence under a code that *is* in the map.
- **`ACCEPTED` and `CANCELLED` are not reason codes at all.** They appear only as `RestartAttemptRecord.outcomeCode` in the audit log (`state: "shutting_down"` / `state: "cancelled"`), never as a response `reason`.
- **`SHUTDOWN_TIMEOUT` is declared but never raised by the plugin.** No plugin code path emits it — the plugin does not wait for its own exit. The supervisor reports the same condition as `SHUTDOWN_ABANDONED`, which is the name to grep for; the supervisor's own `WAITING_FOR_EXIT` state has no deadline, so a hung shutdown is waited on indefinitely. Treat the entry as reserved.
- The map's sentences are not the `detail` strings: the response `detail` is the more specific validator or abort text (for example `no checkpoint port is bound and safety.checkpointRequired is true, so a restart cannot be authorized`), and the audit `outcomeCode` is the code itself. Log the code, quote the detail.
</details>
