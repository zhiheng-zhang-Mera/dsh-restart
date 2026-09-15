# Failure modes

What `dsh-restart` does when each part of it breaks, what an operator sees, and how to get back
to a working state.

> **The guarantee.** The worst outcome this plugin is allowed to produce is **"automatic restart unavailable"**, never **"DS-Hns unavailable"**. Every section below can be checked against that sentence: nothing on this plugin's failure path stops, signals, modifies or blocks DS-Hns.

Related reading: [`../README.md`](../README.md), [`architecture.md`](architecture.md),
[`protocol.md`](protocol.md), [`acceptance.md`](acceptance.md).

---

## 1. Restart plugin crashes

**Trigger.** The plugin module throws, its `apply()` fails, the profile stops loading it, or the host process dies while the plugin is mid-request.

**Expected behaviour.** Nothing in the plugin's lifecycle can prevent DS-Hns from starting or keep it running: `applyRestart()` reports configuration problems and continues on the shipped defaults, and `src/index.ts` declares `inject = []`, so a missing tool or settings service does not block activation either. A crashed plugin simply stops answering — no new ticket is written, no new restart can be requested. A crash *after* a ticket was written leaves the ticket on disk.

**What an operator sees.** `restart_status` is no longer served, or the plugin's tools are gone. A previous process's ticket is reconciled loudly at the next startup — `dsh-restart: discarded a pending ticket from request tool-1780000000000-482913 (written 2026-06-01T09:00:00.000Z); the previous process did not exit`. A plugin that never wrote a ticket is invisible to the supervisor, which only sees a pid that is gone and treats it as an ordinary crash:

```json
{"timestamp":"2026-06-01T09:00:00.000Z","state":"MONITORING","code":"process_died_without_ticket","message":"pid 4242 is gone","detail":{"failuresInWindow":1,"limit":3}}
```

**How to recover.**

```powershell
dsh --profile web --dump-config | Select-String dsh-restart  # is it loaded at all?
pwsh -File scripts/install.ps1 -Profile web -WhatIf           # inspect first, change nothing
pwsh -File scripts/install.ps1 -Profile web                   # re-register and verify
Remove-Item -LiteralPath "$env:DSH_HOME\restart\ticket.json" -Force   # only if you will not start the plugin
```

---

## 2. Supervisor crashes

**Trigger.** `bin/supervisor.mjs` exits, is killed, or was never started.

**Expected behaviour.** DS-Hns keeps running. The plugin detects the absence from the heartbeat file's age and refuses every request, because exiting with nobody to relaunch is a shutdown, not a restart:

```json
{"accepted":false,"state":"rejected","reason":"SUPERVISOR_ABSENT","detail":"no supervisor heartbeat was seen; set safety.allowRestartWithoutSupervisor = true to restart anyway","requestId":"tool-1780000000000-482913"}
```

The threshold is `supervisor.heartbeatTimeoutMs` (default 30000 ms), measured against the heartbeat's own `timestamp` and falling back to the file's mtime. Nothing in this path touches DS-Hns.

**What an operator sees.** Status reports the supervisor absent while the host is fine: `"supervisor": { "present": false, "lastSeenAt": "2026-06-01T08:58:00.000Z", "ageMs": 120000 }`. When it exited through its own loop, the last log line is a stop rather than a crash:

```json
{"timestamp":"2026-06-01T09:01:40.000Z","state":"MONITORING","code":"supervisor_stopped","message":"supervisor finished: TICK_LIMIT","detail":{"state":"MONITORING","reason":"TICK_LIMIT","relaunches":1,"safeMode":false}}
```

**How to recover.** Restart it with the **same** `--state` directory and an explicit `--pid`, because a detached start otherwise watches its own parent:

```powershell
node bin/supervisor.mjs --state "$env:DSH_HOME\restart" --pid 4242 -- node dsh.js --profile web
```

Then confirm presence by reading `heartbeat.json` (`timestamp`, `watchedPid`, `supervisorPid`) — see [`operations.md`](operations.md#health-checks-an-operator-can-run).

---

## 3. Checkpoint fails

**Trigger.** Any of: no checkpoint port is bound and the request requires one (the default
unconfigured install); the port throws; the port does not answer inside `safety.shutdownTimeoutMs`;
the port answers `safe: false`; the port answers `safe: true` but `completed: false`.

**Expected behaviour.** The restart is **aborted, never downgraded**. The ticket is written only
after the gate has passed, so a supervisor can never observe a ticket for a restart that was
refused. The lock is released and the attempt is recorded.

**What an operator sees.** Real `detail` strings:

| Code | Observed `detail` |
| --- | --- |
| `CHECKPOINT_FAILED` (no port) | `no checkpoint port is bound and safety.checkpointRequired is true, so a restart cannot be authorized` |
| `CHECKPOINT_FAILED` (threw) | `restart aborted: prepareForRestart threw: checkpoint subsystem exploded (reason checkpoint_threw)` |
| `CHECKPOINT_REQUIRED` | `restart aborted: harness reports git_commit_in_progress (reason git_commit_in_progress)` |

A thrown or unsafe checkpoint answers `{"accepted": false, "state": "failed", ...}`; the no-port
case answers `"state": "rejected"`. Either way the refusal reaches the audit log:

```json
{"schemaVersion":1,"kind":"restart-attempt","record":{"requestId":"req-from-nowhere","ticketId":null,"mode":"application","source":"some-random-app","reasonCode":"OPERATOR_REQUEST","state":"rejected","startedAt":"2026-06-01T09:00:00.000Z","finishedAt":"2026-06-01T09:00:00.000Z","detail":"source \"some-random-app\" is not allowed; allowed sources: dsh-health-scheduler, dsh-cli, operator","clean":true,"outcomeCode":"UNKNOWN_SOURCE"}}
```

**How to recover.** Bind a real checkpoint port (`FunctionCheckpointPort` for an in-process harness,
`FileCheckpointPort` for a host that can only publish a readiness document) or — only if the
deployment genuinely has no safe point to reach — set `safety.checkpointRequired: false`. Do not
weaken it just to make a refusal go away; see
[`operations.md`](operations.md#tuning-guidance).

---

## 4. Graceful-shutdown hang

**Trigger.** The host accepts the graceful-shutdown request but never exits.

**Expected behaviour — and the honest state of it.** This case is **half implemented**, and the two
halves differ.

*The plugin half is correct.* `RestartManager` never awaits its own exit: it writes the ticket, requests the shutdown, records `state: "shutting_down"` / `outcomeCode: "ACCEPTED"`, and returns. A hung host cannot deadlock the plugin.

*The supervisor half has a bounded deadline.* `WAITING_FOR_EXIT` polls liveness and returns `{state: "WAITING_FOR_EXIT", reason: "WAITING"}` on every tick, forever. The design calls for `等待 timeout → supervisor policy → 可选 force terminate → 记录 dirty restart`; none of that exists:

- `safety.allowForceTerminate` is read, but only after `WAITING_FOR_EXIT` exceeds `safety.shutdownTimeoutMs`, and it still needs a bound `ProcessTerminator`. The shipped `bin/supervisor.mjs` binds one only when that setting is on, so the default supervisor cannot terminate anything.
- There is **no timeout** on `WAITING_FOR_EXIT`, and **no "dirty restart" record** is written anywhere.
- `safety.shutdownTimeoutMs` is not a watchdog over the host's exit; in the implementation it is the budget for the **checkpoint** call only.

**What an operator sees.** The accepted ticket, then nothing but heartbeats:

```json
{"timestamp":"2026-06-01T09:00:05.000Z","state":"WAITING_FOR_EXIT","code":"restart_ticket_accepted","message":"restart_ticket_accepted","detail":{"ticketId":"application-1780304400000-1-e2efb725","mode":"application","pid":4242}}
```

Meanwhile the plugin reports the lock as held and refuses a second attempt — `{"accepted":false,"state":"rejected","reason":"RESTART_IN_FLIGHT","detail":"another restart is already in progress","requestId":"tool-1780000300000-119284"}`.

**How to recover.** Neither side will terminate anything, so resolving the hang is a human action outside this plugin: fix whatever blocks the host's exit, or terminate the host process by hand. Once the pid is genuinely gone the supervisor clears the ticket and relaunches by itself — no supervisor restart needed — logging `{"timestamp":"2026-06-01T09:00:05.000Z","state":"RELAUNCHING","code":"relaunching","message":"relaunching","detail":{"reason":"expected_exit_observed"}}`.

---

## 5. No heartbeat after restart

**Trigger.** The supervisor relaunched DS-Hns, but the pid is not alive when `supervisor.relaunchTimeoutMs` (default 90000 ms) elapses.

**Expected behaviour.** The supervisor retries, bounded by the crash-loop breaker, then stops relaunching and enters safe mode. It never relaunches forever.

**What an operator sees.** The real progression, one JSON object per line:

```json
{"timestamp":"2026-06-01T09:00:00.000Z","state":"WAITING_FOR_HEARTBEAT","code":"relaunched","message":"relaunched","detail":{"pid":20002}}
{"timestamp":"2026-06-01T09:01:40.000Z","state":"WAITING_FOR_HEARTBEAT","code":"relaunch_verification_failed","message":"the relaunched process is not alive","detail":{"failuresInWindow":2,"limit":3}}
{"timestamp":"2026-06-01T09:01:40.000Z","state":"RELAUNCHING","code":"relaunching","message":"relaunching","detail":{"reason":"relaunch_retry"}}
{"timestamp":"2026-06-01T09:03:20.000Z","state":"CRASH_LOOP","code":"crash_loop_limit_reached","message":"crash_loop_limit_reached","detail":{"failuresInWindow":3}}
{"timestamp":"2026-06-01T09:03:20.000Z","state":"SAFE_MODE","code":"safe_mode_entered","message":"safe_mode_entered","detail":{"reason":"no_liveness_after_relaunch","relaunches":2}}
```

Per-tick results in order —
`[{"state":"WAITING_FOR_HEARTBEAT","reason":"RELAUNCHED","relaunches":1,"safeMode":false}, {"state":"WAITING_FOR_HEARTBEAT","reason":"RELAUNCHED","relaunches":2,"safeMode":false}, {"state":"SAFE_MODE","reason":"CRASH_LOOP","relaunches":2,"safeMode":true}]`
— persisted as a ledger in which the breaker's state survives:

```json
{
  "schemaVersion": 1,
  "uncleanStarts": [
    { "at": "2026-06-01T09:00:00.000Z", "reason": "process_died_without_ticket" },
    { "at": "2026-06-01T09:01:40.000Z", "reason": "no_liveness_after_relaunch" },
    { "at": "2026-06-01T09:03:20.000Z", "reason": "no_liveness_after_relaunch" }
  ],
  "safeMode": true,
  "safeModeReason": "no_liveness_after_relaunch",
  "safeModeAt": "2026-06-01T09:03:20.000Z",
  "relaunches": 2
}
```

The process ends with exit code **3** and prints the manual-action line:

```text
automation is disabled; DS-Hns still runs. Fix the underlying problem, then delete the safeMode flag in ledger.json (or run scripts/enable.ps1) to restore automatic restart.
```

That sentence is true only when DS-Hns is up and the plugin was the problem: safe mode stops relaunching, it does not launch a degraded DS-Hns.

**How to recover.** Fix the underlying start failure first, then clear the flag and restart the supervisor. Clearing safe mode does **not** start it.

```powershell
pwsh -File scripts/enable.ps1 -Mechanism SafeMode -ClearHistory
node bin/supervisor.mjs --state "$env:DSH_HOME\restart" --pid 4242 -- node dsh.js --profile web
```

Two further caveats: the relaunch backoff **doubles per consecutive failure** up to `supervisor.relaunchBackoffMaxMs`, so the retry rate is bounded by both that curve and the breaker — and the breaker's *state* is durable while the plugin's own counters are not; see [case 6](#6-restart-request-storm).

---

## 6. Restart-request storm

**Trigger.** A requester retries aggressively, a scheduler fires repeatedly, or several sources ask for a restart at once.

**Expected behaviour.** Four independent defences, in this order: shape validation, duplicate suppression, the exclusive lock, then cooldown.

**What an operator sees.** Every refusal code below with its real `detail`:

| Code | Observed `detail` |
| --- | --- |
| `DUPLICATE_REQUEST_ID` (identical retry) | the **first answer returned verbatim** — `accepted: true`, `state: "shutting_down"`, `ticketId: "application-1780304400000-1-ef102451"` — and no second restart |
| `DUPLICATE_REQUEST_ID` (same id, new content) | `request id req-1 was already used for a different request` |
| `RESTART_IN_FLIGHT` | `another restart is already in progress` |
| `COOLDOWN_ACTIVE` | `application restart is in cooldown for another 600s (minimum interval 1200s)` |

**How to recover.** Normally, do nothing: the cooldown expires and the next legitimate request is accepted. `restart_status` shows it draining — `"application": { "nextAllowedAt": "2026-06-01T09:20:00.000Z", "remainingMs": 900000, "minimumIntervalMs": 1200000 }` — and the cooldown table itself is in [`operations.md`](operations.md#configuration-reference).

**The caveat that matters.** The cooldown deadlines, the duplicate ledger and the crash-loop view are **per-process in-memory state in `RestartManager`** and do **not** survive the restart they gate: a new process starts with `cooldownUntil = 0`, an empty `seen` map (bounded at 200 entries) and an untripped breaker. What survives is the supervisor's ledger, which the supervisor reads back at startup.

---

## 7. Ticket that does not verify

**Trigger.** `ticket.json` exists but fails verification: `missing`, `schema_version`, `checksum`, `expired`, `malformed`, or `wrong_pid`.

**Expected behaviour.** A doubtful ticket is a hazard, not a hint. The supervisor deletes it and keeps monitoring instead of acting on it, logging `{"timestamp":"2026-06-01T09:00:05.000Z","state":"MONITORING","code":"discarded_unverifiable_ticket","message":"<verification detail>","detail":{"rejection":"checksum"}}`. The plugin behaves the same way at startup: `reconcileAfterRestart()` discards any ticket it finds and reports why.

**What an operator sees.** A ticket rejected for a drifted checksum is readable; its `checksum` simply no longer covers its contents:

```json
{
  "schemaVersion": 1,
  "ticketId": "application-1780304400000-1-e2efb725",
  "requestId": "tool-1780000000000-482913",
  "mode": "application",
  "reasonCode": "RUNTIME_PRESSURE",
  "pid": 4242,
  "createdAt": "2026-06-01T09:00:00.000Z",
  "expiresAt": "2026-06-01T09:10:00.000Z",
  "cleanShutdown": true,
  "checkpointId": "ck-2026-06-01T09-00-00",
  "checksum": "sha256:3e6ffa34cad2551ac4fab178509303a86573f8aa33dc8cbfae53404af47f06ea"
}
```

**How to recover.** Nothing to recover: discarding it *is* the correct outcome and the audit trail is unaffected. If tickets keep failing to verify, suspect a foreign writer in the state directory or a clock skewed past `expiresAt` (default `supervisor.ticketTtlMs` = ten minutes).

**A gap found by reading the code — not demonstrated.** After a ticket write fails, `RestartManager.abort()` calls `clearTicket()` **before** releasing the lock. If the ticket can neither be written nor deleted — on Windows, a foreign process holding `ticket.json` open is the plausible cause — `clearTicket()` throws, the exception escapes `handle()`, no audit record is written, and the lock is never released. The caller sees a thrown exception rather than a structured response, and a later request is refused with `RESTART_IN_FLIGHT`. This is a code-reading observation, not a reproduction. Treat a `RESTART_IN_FLIGHT` refusal with no corresponding audit line as this signature.

---

## 8. State directory unwritable

**Trigger.** The directory named by `--state` (supervisor) or `options.stateDirectory` / `storage.directory` (plugin) cannot be created, is read-only, or is on a full volume.

**Expected behaviour.** Every write fails closed and nothing is thrown at the host. The supervisor refuses to start with exit code **2**; the plugin aborts with `TICKET_WRITE_FAILED`; the audit log swallows its own failure and counts it.

**What an operator sees.** At supervisor startup, on stderr, exit code 2: `supervisor: cannot create state directory <dir>: <error message>`. From the plugin when the ticket cannot be written:

```json
{"accepted":false,"state":"failed","reason":"TICKET_WRITE_FAILED","detail":"restart aborted: could not write the restart ticket (<error message>)","requestId":"tool-1780000000000-482913","ticketId":"application-1780304400000-1-2c1a9f33"}
```

The heartbeat writer and the `supervisor.log` writer both swallow their errors by design, so the observable symptom is **silence**: no new `heartbeat.json`, no new log lines, and the plugin then reports the supervisor absent.

**How to recover.**

```powershell
Set-Content -LiteralPath "$env:DSH_HOME\restart\writetest.tmp" -Value ok   # prove writability first
Remove-Item -LiteralPath "$env:DSH_HOME\restart\writetest.tmp" -Force
pwsh -File scripts/install.ps1 -Profile web -StateDirectory 'D:\DS-Hns\data\restart'
node bin/supervisor.mjs --state D:\DS-Hns\data\restart --pid 4242 -- node dsh.js --profile web
```

**The caveat that matters.** The plugin and the supervisor must name the *same* directory — the plugin defaults to `<DSH_HOME>\restart`, the supervisor to `--state` and otherwise `<DSH_HOME>\restart` (falling back to `./.dsh-restart`). Passing `-StateDirectory` to a script does **not** propagate it into the profile, so set `storage.directory` in the profile *or* pass `--state` to the supervisor, and make them agree. A mismatch looks exactly like "no supervisor heartbeat" and is the most likely cause of a mysterious `SUPERVISOR_ABSENT`. Note also that `RestartAuditLog` tracks `writeFailures` and `lastError` but neither is surfaced in `restart_status` in this release.

---

## 9. Config rejected at load

**Trigger.** The profile's configuration document cannot be enforced — a wrong type, a non-positive duration, a cross-field contradiction, or an empty `allowedSources`.

**Expected behaviour.** The plugin **does not fail the host's boot**. It logs the problem and continues on the shipped defaults; the supervisor logs the problem and exits non-zero rather than supervising with unknown bounds.

```text
dsh-restart: configuration was rejected (<config error>); continuing with the shipped defaults. Fix the offending value and reload the profile to activate it.
```

**What an operator sees.** The exact messages:

```text
ConfigError: dsh-restart config: supervisor.heartbeatTimeoutMs must exceed supervisor.heartbeatIntervalMs (60000), received 30000
ConfigError: dsh-restart config: allowedSources must list at least one source; an empty list would refuse every request, including an operator request
ConfigError: dsh-restart config: allowedPriorities[] unknown priority "urgent"; known: low, normal, high, emergency
ConfigError: dsh-restart config: applicationRestart.minIntervalMs must be >= 0, received -1
ConfigError: dsh-restart config: enabled must be a boolean, received "yes"
```

The last one is the one to watch: `tryResolveConfig({ enabled: 'yes' })` reports the error and **falls back to `enabled: true`**. A typo can therefore leave restarts armed rather than disarmed — the opposite of what the author intended.

**How to recover.** Fix the named dotted path in the profile patch and reload the profile. Settings changes are validated but **not hot-swapped**: the running process keeps the bounds it started with, and the new document applies at the next profile load. Check without booting the host with `node -e "import('./lib/index.js').then(m => console.log(m.resolveConfig()))"` or `npm run verify:artifacts`.

**A divergence worth knowing.** `bin/supervisor.mjs` calls `resolveConfig({})` — it never reads the profile's plugin configuration. `supervisor.launchCommand`, `launchArgs`, `launchCwd`, `heartbeatIntervalMs`, `relaunchTimeoutMs`, `pollIntervalMs`, `ticketTtlMs` and `crashLoopLimit` are all at their **shipped defaults** inside a supervisor started from the CLI, whatever the profile says. Pass `--` for the launch command and accept the defaults; a profile cannot currently tune the supervisor.

---

## 10. Relaunch command cannot be derived / relaunch fails

**Trigger.** The supervisor needs to relaunch and either cannot work out *what* to launch, or the launch itself fails (wrong path, missing interpreter, permission denied).

**Expected behaviour.** Both are terminal, and neither loops. A missing command enters safe mode without launching anything; a failed launch counts against the crash-loop breaker and either retries once or trips the breaker.

**What an operator sees.** No command at all:

```json
{"timestamp":"2026-06-01T09:00:05.000Z","state":"RELAUNCHING","code":"no_launch_command","message":"cannot relaunch: no launch command could be derived"}
```

which sets `SAFE_MODE` and returns `{"state":"SAFE_MODE","reason":"NO_LAUNCH_COMMAND",...}`. A launch that failed:

```json
{"timestamp":"2026-06-01T09:00:05.000Z","state":"RELAUNCHING","code":"relaunch_failed","message":"spawn failed: spawn <file> ENOENT","detail":{"failuresInWindow":1}}
```

followed by `{"state":"RELAUNCHING","reason":"RELAUNCH_FAILED",...}` while the breaker allows another attempt, or by `CRASH_LOOP` → `SAFE_MODE` when it does not.

**How to recover.** Always give the supervisor the command explicitly, after `--`:

```powershell
node bin/supervisor.mjs --state "$env:DSH_HOME\restart" --pid 4242 -- node "D:\DS-Hns\app\dsh.js" --profile web
```

Without `--`, `deriveLaunchSpec()` falls back to the supervisor's own `argv`, which is `bin/supervisor.mjs` itself — the supervisor would relaunch *itself*, not DS-Hns. This was verified and is the most important deployment caveat in this document; see [`operations.md`](operations.md#running).

---

## Not implemented yet

Behaviour the design document specifies that this release does **not** implement. Nothing here is half-on: each item is simply absent, and the sections above say what happens instead.

| Design item | Status in this release | Consequence |
| --- | --- | --- |
| System reboot on a live machine | the port is implemented, exported, tested **and called** by `RestartManager`; the reboot itself has not been exercised here | an accepted `mode: "system"` request writes a `mode: "system"` ticket and then asks the machine's own restart port. On a machine with no port the request is refused rather than downgraded |
| Supervisor reading the profile configuration | `bin/supervisor.mjs` calls `resolveConfig({})` | profile-level supervisor tuning has no effect |
| `supervisor.detach` | validated, and read only by `spawnSupervisor()`, which this package never calls; `ChildProcessLauncher` hard-codes `detached: false` | the key is documentation-only in practice |
| Durable cooldown/dedupe counters | the plugin's counters are per-process, though the supervisor's safe-mode ledger is now read back | cooldown bounds reset when the gated process restarts |
| Safe mode launching a degraded DS-Hns | it does **not** launch anything; it stops relaunching | "DS-Hns still runs" holds only when DS-Hns is up and the plugin was the problem |
| Rotation for `supervisor.log` | absent; it grows unbounded | only the audit log honours `storage.maxLogBytes` |

Implemented in this release, and covered by named tests:

| Design item | Status | Where |
| --- | --- | --- |
| Force-terminate after a shutdown timeout | read once `safety.shutdownTimeoutMs` expires, and a `ProcessTerminator` must also be bound; the shipped supervisor binds one only when the setting is on | `supervisor.test.js` → `a shutdown that never lands` |
| A deadline on `WAITING_FOR_EXIT`, and a "dirty restart" record | both present: the wait is bounded, and a forced end writes an `uncleanStarts` entry | same suite |
| `CheckpointPort.acknowledgeResume` in the pipeline | the supervisor calls it the moment a relaunch is observed alive; a failure is logged, not fatal | `supervisor.test.js` → `resume acknowledgement` |
| A backoff curve between relaunch retries | doubles per consecutive failure up to `supervisor.relaunchBackoffMaxMs` | `supervisor.test.js` → `relaunch pacing` |
| The plugin reading the supervisor's safe-mode ledger | `ledger.json`'s `safeMode` folds into the plugin's `CRASH_LOOP` refusal | `manager.test.js` → `supervisor safe mode is bridged into the plugin` |
