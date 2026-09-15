# dsh-restart

**Safe restart execution for DeepSeek Harness — it decides *how* to restart safely, never *whether* one is warranted.**

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20.11.0-brightgreen.svg)](package.json)
[![DSH compatibility](https://img.shields.io/badge/DSH-%40deepseek--ai%2Fcordis%20%5E4.0.1-informational.svg)](package.json)
[![Plugin type](https://img.shields.io/badge/plugin-bundle%20patch%20%2B%20external%20supervisor-purple.svg)](cordis.patch.yml)

English | [中文](README.zh.md)

`dsh-restart` receives a restart request, validates it, takes an exclusive lock, gates on a checkpoint, writes a checksummed ticket, asks the host for a graceful shutdown, and lets an **external supervisor** observe the exit and relaunch. It contains no health policy, no temperature thresholds, no time-of-day scheduling and no task-queue access. Its worst-case failure is *"automatic restart unavailable"* — never *"DS-Hns unavailable"*.

---

## What it does / what it explicitly does not do

The boundary is the product. Everything in the right-hand column belongs to a different component, and nothing in it may be pulled back into this one.

| Responsibility | dsh-restart | Health Scheduler | Supervisor | DS-Hns Core |
| --- | --- | --- | --- | --- |
| Sense pressure (CPU, memory, thermal, runtime) | **no** | yes | no | no |
| Judge whether a restart is warranted | **no** | yes | no | no |
| Schedule maintenance windows | **no** | yes | no | no |
| Accept and validate a restart request | **yes** | submits | no | no |
| Enforce the exclusive restart lock | **yes** | no | no | no |
| Enforce cooldowns and duplicate suppression | **yes** | no | no | no |
| Gate on a checkpoint / safe point | **yes** (asks, believes only the answer) | no | no | **yes** (produces it) |
| Save and restore task state | **no** | no | no | **yes** |
| Write the restart ticket | **yes** | no | no | no |
| Request a graceful shutdown | **yes** (through a port) | no | no | owns its own exit |
| Observe the exit and relaunch | **no** | no | **yes** | no |
| Break a crash loop / enter safe mode | **no** | no | **yes** | no |
| Read or modify the task queue | **no** | no | **no** | **yes** |
| Reboot the operating system | **gated three ways, and wired** (see [Safety notes](#safety-notes)) | requests it | no | no |

Read that table as three seams: `dsh-health-scheduler` decides, `dsh-restart` executes, the supervisor relaunches. Each can be absent without breaking the others.

---

## Install

`dsh-restart` ships as a DSH **bundle**: `package.json` declares
`dsh.bundle.patch = ./cordis.patch.yml`, and that patch inserts exactly one plugin row.

### From a checkout

```powershell
dsh plugin --profile web add D:\dsh-plugin-develop\dsh-restart
dsh --profile web --dump-config | Select-String dsh-restart
```

The first command appends the package to the profile's `dsh.profile.bundles`; the second proves the composed profile actually mentions it. Do not treat the install as done until `--dump-config` shows the plugin: a bundle that fails to resolve leaves the profile looking installed.

### From npm or a tarball

```powershell
dsh plugin --profile web add dsh-restart
# or, from a packed artifact
npm pack
dsh plugin --profile web add .\dsh-restart-0.1.0.tgz
```

These are the recommended paths. The published package contains `lib/`, `src/`, `bin/`,
`cordis.patch.yml`, this README and the license, so no build step runs on the installing
machine.

### From git, and the build caveat

```powershell
dsh plugin --profile web add github:dsh-restart/dsh-restart
```

A git install runs the package's `prepare`/`prepack` script, which is
`npm run build` — **arbitrary code execution at install time**, gated by your package
manager:

- npm ≥ 7 does not run `prepare` for git dependencies unless the dependency is allowed
  to run scripts; a profile that installs with `--ignore-scripts` (or a managed profile
  that predates an `allowBuilds` entry for this package) gets `lib/` missing.
- pnpm requires the package to be listed in `onlyBuiltDependencies` / `allowBuilds` in
  the profile's `pnpm-workspace.yaml` (or `.npmrc`) before it will run `prepare`.
- An npm/tarball install never hits this: `lib/` is already built and shipped.

If a git install loads and then reports `no lib/index.js`, that is this caveat and not a
plugin bug: run `npm run build` in the checkout, or install from npm/tarball instead.

### With the helper script

```powershell
pwsh -File scripts/install.ps1                     # register, verify, smoke test
pwsh -File scripts/install.ps1 -WhatIf             # print every action, change nothing
pwsh -File scripts/install.ps1 -SkipSupervisor     # register only
```

`install.ps1` registers the plugin, verifies the profile with `--dump-config`, optionally launches the supervisor detached, and smoke-tests `node bin/supervisor.mjs --help`. It is idempotent: it asks the profile whether the plugin is already registered before adding it, and it stops rather than adding a second registration on a guess. See [docs/operations.md](docs/operations.md#the-powershell-scripts).

---

## The supervisor

The supervisor is a **separate, long-lived process**. It is the only thing that can relaunch DS-Hns after it exits, and it must outlive the process it watches, so it is started detached:

```powershell
node bin/supervisor.mjs --state "$env:DSH_HOME\restart" -- node dsh.js --profile web
```

```
Usage:
  node bin/supervisor.mjs [options] [-- <launch command>]

Options:
  --state <dir>              directory holding ticket.json, heartbeat.json and ledger.json
                             (default: %DSH_HOME%\restart, else ./.dsh-restart)
  --pid <pid>                watch this pid instead of the parent process
  --tick-ms <ms>             poll interval (default: supervisor.pollIntervalMs)
  --max-ticks <n>            stop after n ticks (default: run until a terminal state)
  --terminate-after-verify   exit after a relaunch is verified, instead of resuming
  -h, --help                 show this message
```

**Why it must be detached.** The supervisor's job is to be alive when DS-Hns is not. A
child process of DS-Hns would die with it, which is precisely when it is needed. Start it
detached, with `Start-Process -WindowStyle Hidden` or the Task Scheduler, and give it its
own log file.

**Why `-- <launch command>` matters.** Without `--`, the supervisor derives the relaunch
command from its own `argv`, which is `bin/supervisor.mjs` — not DS-Hns. Always pass `--`
in a deployment, or set `supervisor.launchCommand` in the configuration.

**What it writes**, all inside `--state <dir>`:

| File | Written by | Contents |
| --- | --- | --- |
| `ticket.json` | plugin | the checksummed restart ticket (see [docs/protocol.md](docs/protocol.md#the-ticket-document)) |
| `heartbeat.json` | supervisor | `schemaVersion`, `supervisorPid`, `watchedPid`, `state`, `timestamp`, `sequence` |
| `ledger.json` | supervisor | `uncleanStarts`, `safeMode`, `safeModeReason`, `safeModeAt`, `relaunches` |
| `supervisor.log` | supervisor | one JSON object per line, mirrored to stderr |
| `restart-attempts.jsonl` | plugin | the append-only audit log; rotated to `.bak` at `storage.maxLogBytes` |

**Exit codes** (verified against the real binary):

| Code | Meaning | What an operator should do |
| --- | --- | --- |
| `0` | the run reached a terminal state (`supervisor_stopped`, e.g. `TICK_LIMIT`, `VERIFIED`) | nothing |
| `1` | fatal: an unknown option or an unhandled error | read the stack trace on stderr; fix the command line |
| `2` | the state directory could not be created | fix the path or its permissions |
| `3` | **safe mode**: the crash-loop breaker is tripped, or the run ended in `CRASH_LOOP` | a human must look at the machine; see [recovering from safe mode](docs/operations.md#recovering-from-safe-mode) |

Exit code 3 is deliberately distinct: a wrapper script or the Task Scheduler can tell
"a human must look at this" apart from "it worked".

---

## Request flow

```
requester (dsh-health-scheduler / dsh-cli / operator)
        │  RestartRequest
        ▼
  validateShape ──► INVALID_REQUEST
        ▼
  duplicate ledger ──► DUPLICATE_REQUEST_ID
        ▼
  validateRequest ──► DISABLED · UNKNOWN_SOURCE · MODE_NOT_ALLOWED
        │             SYSTEM_REBOOT_NOT_PERMITTED · CRASH_LOOP
        │             RESTART_IN_FLIGHT · COOLDOWN_ACTIVE
        │             CHECKPOINT_FAILED · SUPERVISOR_ABSENT
        ▼
  lock.transition(REQUESTED) ──► RESTART_IN_FLIGHT (illegal edge)
        ▼
  lock CHECKPOINTING · gate.prepare() ──► CHECKPOINT_FAILED · CHECKPOINT_REQUIRED
        ▼
  write ticket.json (atomic, checksummed) ──► TICKET_WRITE_FAILED
        ▼
  lock SHUTTING_DOWN · shutdown.requestShutdown(ticketId)
        │                              └──► SHUTDOWN_PORT_UNAVAILABLE
        ▼
  accepted:true ─ the process is expected to exit now
        ▼
  ── process boundary ──
        ▼
  supervisor: MONITORING → WAITING_FOR_EXIT → RELAUNCHING
            → WAITING_FOR_HEARTBEAT → VERIFIED → MONITORING
```

The plugin's part ends at `accepted: true`. Everything after the process boundary is the supervisor's, and it is driven by the ticket on disk rather than by anything held in memory — which is what lets the whole thing survive the restart it is performing.

### Every refusal code

`reason` in a `RestartResponse` is one of these. `state` is `rejected` when the request
never started, `failed` when it started and was aborted. All strings below are the real
`detail` values.

| Code | Trigger | Fix |
| --- | --- | --- |
| `INVALID_REQUEST` | the request is not an object; a required field is missing, empty, oversized or contains control characters; `mode` is not `application`/`system`; `checkpointRequired` is not a boolean; `priority` is unknown; a field has the wrong type | send the shape in [docs/protocol.md](docs/protocol.md#restartrequest); `requestId` ≤ 128, `source` ≤ 64, `reasonCode` ≤ 64, `reasonSummary` ≤ 500 characters |
| `INVALID_REQUEST` (priority) | `priority` is valid but not listed in `allowedPriorities` | add it to `allowedPriorities`, or use an accepted priority |
| `DISABLED` | `enabled: false` | `enabled: true`, or `scripts/enable.ps1` |
| `UNKNOWN_SOURCE` | `source` is not in `allowedSources` | add the requester to `allowedSources` |
| `MODE_NOT_ALLOWED` | the mode's own `enabled` is false (`systemRestart.enabled` is false by default) | enable that mode — and, for system, also `allowSystemReboot` |
| `SYSTEM_REBOOT_NOT_PERMITTED` | `allowSystemReboot` is false, or the request omits `acknowledgeSystemReboot` | both gates must pass: configuration **and** the request's own acknowledgement |
| `CRASH_LOOP` | the crash-loop breaker has disabled automatic restart | fix the underlying crash, then clear the breaker (`scripts/enable.ps1`) |
| `DUPLICATE_REQUEST_ID` | the same `requestId` replayed with **different** content | use a new `requestId`; an identical replay returns the first answer instead and is not a refusal |
| `RESTART_IN_FLIGHT` | the lock is not `IDLE`, or the lock refused the transition | wait for the in-flight restart, or let it fail; never queue a second one |
| `COOLDOWN_ACTIVE` | a restart of this mode happened less than `minIntervalMs` ago | wait out `cooldowns.<mode>.remainingMs`, or change the configured bound deliberately |
| `CHECKPOINT_FAILED` | no checkpoint port is bound and `checkpointRequired` is true; the port threw; the port did not answer inside `safety.shutdownTimeoutMs` | bind a checkpoint port (`applyRestart` option `checkpoint`), or set `checkpointRequired: false` on requests that genuinely do not need one |
| `CHECKPOINT_REQUIRED` | the harness answered that it is **not** safe to restart (e.g. `git_commit_in_progress`) and the request required a checkpoint | wait for the safe point; do not force it |
| `SUPERVISOR_ABSENT` | no heartbeat inside `supervisor.heartbeatTimeoutMs` | start the supervisor; or set `safety.allowRestartWithoutSupervisor: true` and accept that exiting is then not restarting |
| `SHUTDOWN_PORT_UNAVAILABLE` | the shutdown port returned false, or threw | wire a lifecycle into `applyRestart`, or accept that a graceful restart is impossible |
| `TICKET_WRITE_FAILED` | the ticket could not be published on disk | fix the state directory's permissions or free space; the ticket is deleted and the lock released before the refusal is returned |

Two more machine-readable codes appear in the audit log but never as a `reason`:
`ACCEPTED` (the attempt was accepted) and `CANCELLED` (the requester cancelled it).

<details>
<summary>Order of checks, and why it matters</summary>

`validateShape` runs before everything, so a malformed request never reaches the cooldown
ledger, the duplicate map or the code that writes files. Then, in order:
`enabled` → `allowedSources` → `allowedPriorities` → mode `enabled` → system gates →
crash-loop breaker → duplicate id → lock → cooldown → checkpoint port → supervisor
presence. Cheap structural refusals come first; the refusal an operator sees is the first
one that applies, not a summary of all of them.
</details>

---

## Failure modes

The design document's six cases, and what this code actually guarantees for each. Full
detail, including what an operator sees and how to recover, is in
[docs/failure-modes.md](docs/failure-modes.md).

| # | Case | Guaranteed behaviour |
| --- | --- | --- |
| 1 | **The plugin crashes** | DS-Hns keeps running. The plugin never owns the app's lifecycle: it has no timers that exit the process, and a throw inside `apply` cannot prevent the host from booting. A restart that was mid-flight leaves a ticket; the next process's `reconcileAfterRestart()` deletes it and reports it. |
| 2 | **The supervisor crashes** | DS-Hns keeps running. The heartbeat goes stale, `supervisor.present` becomes false within `heartbeatTimeoutMs`, and every later request is refused with `SUPERVISOR_ABSENT`. Automatic relaunch is lost; graceful restart is still refused rather than downgraded to a shutdown. |
| 3 | **Checkpoint failure** | The restart is aborted, never downgraded. An unsafe answer, an incomplete checkpoint, a thrown port, a timeout and an unbound port all produce `CHECKPOINT_FAILED`/`CHECKPOINT_REQUIRED`, the ticket is deleted and the lock is released. Task state is not touched by this plugin at all. |
| 4 | **Shutdown hangs** | **Implemented, with a bounded wait.** The plugin returns `accepted: true` after the host accepts the shutdown request and never waits for its own exit, so it cannot hang. The supervisor's `WAITING_FOR_EXIT` state has no deadline, so a hung shutdown is waited on indefinitely; `safety.allowForceTerminate` and the design's "record a dirty restart" are not implemented. See [Not implemented yet](#not-implemented-yet). |
| 5 | **No heartbeat after a restart** | The supervisor counts an unclean start when the relaunched pid is not alive after `relaunchTimeoutMs`, relaunches again, and after `crashLoopLimit` failures inside `crashLoopWindowMs` trips the breaker and enters safe mode (exit code 3). Retries are bounded by the breaker, not by a backoff curve. |
| 6 | **Request storm** | Deduplicated by `requestId` (an identical replay returns the first answer), serialised by the exclusive lock, and rate-limited by the per-mode cooldown. Priority never bypasses any of the three. |

---

## Configuration

Every key is optional; the values below are the shipped defaults, and each is documented
with the risk of changing it in [`cordis.patch.yml`](cordis.patch.yml). Types and effects
in full: [docs/operations.md](docs/operations.md#configuration-reference).

| Key | Type | Default | Effect |
| --- | --- | --- | --- |
| `enabled` | boolean | `true` | master switch; `false` refuses every request with `DISABLED` |
| `applicationRestart.enabled` | boolean | `true` | whether application restarts may happen |
| `applicationRestart.minIntervalMs` | number | `1200000` | enforced cooldown between application restarts (20 min) |
| `systemRestart.enabled` | boolean | `false` | whether the system mode may be used |
| `systemRestart.minIntervalMs` | number | `3600000` | enforced cooldown between system restarts (60 min) |
| `allowedSources` | string[] | `dsh-health-scheduler`, `dsh-cli`, `operator` | who may submit; an empty list is a `ConfigError` |
| `allowedPriorities` | string[] | `low`, `normal`, `high`, `emergency` | accepted priority vocabulary |
| `allowSystemReboot` | boolean | `false` | second gate for `mode: system`; a request must also acknowledge |
| `safety.checkpointRequired` | boolean | `true` | whether a requested checkpoint must succeed |
| `safety.duplicateSuppression` | boolean | `true` | whether a replayed `requestId` returns the previous answer |
| `safety.crashLoopLimit` | number | `3` | unclean starts inside the window that trip the breaker |
| `safety.crashLoopWindowMs` | number | `600000` | rolling breaker window (10 min) |
| `safety.safeModeOnLoop` | boolean | `true` | whether tripping the breaker also enters safe mode |
| `safety.shutdownTimeoutMs` | number | `90000` | shutdown budget, also used as the checkpoint budget |
| `safety.allowForceTerminate` | boolean | `false` | declared, validated, **never consulted** by this release |
| `safety.allowRestartWithoutSupervisor` | boolean | `false` | whether to exit with nobody to relaunch |
| `supervisor.heartbeatIntervalMs` | number | `5000` | supervisor heartbeat period |
| `supervisor.heartbeatTimeoutMs` | number | `30000` | age after which the supervisor counts as absent |
| `supervisor.relaunchTimeoutMs` | number | `90000` | time a relaunched pid has to be alive |
| `supervisor.launchCommand` | string[] \| null | `null` | relaunch command; `null` means "reuse the supervisor's argv" |
| `supervisor.launchArgs` | string[] | `[]` | extra arguments appended to the relaunch |
| `supervisor.launchCwd` | string \| null | `null` | working directory for the relaunch |
| `supervisor.pollIntervalMs` | number | `1000` | pid poll interval |
| `supervisor.ticketTtlMs` | number | `600000` | how long a pending ticket stays valid |
| `supervisor.detach` | boolean | `true` | whether the supervisor runs detached — **declared and validated, read only by `spawnSupervisor()`**, which this package never calls: see the divergence note below. Only the uncalled `spawnSupervisor()` consults it |
| `storage.directory` | string \| null | `null` | audit-log directory; `null` = the state directory |
| `storage.maxLogBytes` | number | `4194304` | audit log rotation threshold |
| `storage.maxRecentAttempts` | number | `25` | attempts kept in memory for status |
| `knownReasonCodes` | string[] | nine codes | codes accepted without complaint; unknown ones are logged, not refused |

Invalid documents are refused at load with a dotted path, and the plugin continues on the defaults rather than failing the host's boot. For example:

```
dsh-restart config: supervisor.heartbeatTimeoutMs must exceed supervisor.heartbeatIntervalMs (60000), received 30000
dsh-restart config: allowedSources must list at least one source; an empty list would refuse every request, including an operator request
```

---

## Model-facing tools

Three tools are registered when the profile has a tool runtime. They are a convenience
over the same service the API exposes — **a tool call bypasses no check**: it goes through
`validateShape`, `validateRequest`, the lock, the cooldown and the checkpoint gate exactly
like any other requester, and it is attributed to the `dsh-cli` source.

### `restart_status`

Read-only. No parameters. Real output, trimmed:

```json
{
  "timestamp": "2026-06-01T09:05:00.000Z",
  "enabled": true,
  "lock": "IDLE",
  "can_restart": true,
  "can_restart_reason": "OK",
  "active": null,
  "cooldowns": {
    "application": { "nextAllowedAt": null, "remainingMs": 0, "minimumIntervalMs": 1200000 },
    "system": { "nextAllowedAt": null, "remainingMs": 0, "minimumIntervalMs": 3600000 }
  },
  "crash_loop": { "tripped": false, "failuresInWindow": 0, "limit": 3, "windowMs": 600000, "trippedAt": null, "reason": null },
  "supervisor": { "present": true, "lastSeenAt": "2026-06-01T09:04:58.000Z", "ageMs": 0 },
  "capabilities": {
    "applicationRestart": true,
    "systemRestart": false,
    "checkpointPort": true,
    "shutdownPort": true,
    "supervisorWatch": true
  },
  "recent": []
}
```

`ageMs` is the age of the last beat. `TicketStore.heartbeatAgeMs()` prefers the `timestamp` the supervisor wrote inside `heartbeat.json` and falls back to the file's `mtime` only when that timestamp is missing or unparseable, so `lastSeenAt` and `ageMs` normally describe the same instant. A supervisor that stopped beating leaves both frozen, so it reads as absent within `heartbeatTimeoutMs` — the honest reading.

### `restart_request`

| Parameter | Type | Required | Notes |
| --- | --- | --- | --- |
| `mode` | `application` \| `system` | yes | scope |
| `reason_code` | string | yes | recorded, never parsed (e.g. `RUNTIME_PRESSURE`) |
| `reason_summary` | string | yes | one line, recorded verbatim in the audit log |
| `checkpoint_required` | boolean | no | defaults to `true` |
| `priority` | `low` \| `normal` \| `high` \| `emergency` | no | defaults to `normal` |
| `acknowledge_system_reboot` | boolean | no | required for `mode: "system"` |

Accepted:

```json
{
  "accepted": true,
  "state": "shutting_down",
  "detail": "application restart accepted: the host is shutting down and the supervisor will relaunch it",
  "requestId": "tool-1780000000000-482913",
  "ticketId": "application-1780304400000-1-e2efb725"
}
```

Refused, with the reason reported verbatim:

```json
{
  "accepted": false,
  "state": "rejected",
  "reason": "SUPERVISOR_ABSENT",
  "detail": "no supervisor heartbeat was seen; set safety.allowRestartWithoutSupervisor = true to restart anyway",
  "requestId": "tool-1780000000000-482913"
}
```

### `restart_cancel`

| Parameter | Type | Required |
| --- | --- | --- |
| `request_id` | string | yes |

```json
{
  "cancelled": true,
  "detail": "request tool-1780000000000-482913 cancelled; no restart will happen"
}
```

Cancellation is only possible while the request is still pending: not after the shutdown
has taken effect (`relaunching`/`verifying`), and not once the process that accepted it is
gone. When nothing is pending the tool says so rather than failing:

```json
{
  "cancelled": false,
  "detail": "request tool-1780000000000-482913 is not pending (it may have completed, been refused, or never existed)"
}
```

---

## Degradation and removal

| Situation | What happens |
| --- | --- |
| **No checkpoint port bound** (the default) | `capabilities.checkpointPort` is `false` and every request is refused with `CHECKPOINT_FAILED` while `safety.checkpointRequired` is true. An unconfigured install cannot restart, which is the intended default: no port means "cannot verify", which means "do not restart". |
| **No supervisor running** | `capabilities.supervisorWatch` still reports the capability, but `supervisor.present` is `false` and requests are refused with `SUPERVISOR_ABSENT`. Deliberately: exiting with nobody to relaunch is a shutdown, not a restart. |
| **No system-shutdown port** | `capabilities.systemRestart` is `false` even when `allowSystemReboot` and `systemRestart.enabled` are both true, so a deployment can see that a reboot is impossible. Application restart keeps working. |
| **No tool runtime or settings service** | The plugin logs a warning and continues: `apply` returns `toolNames: []`, restart control stays available through the plugin API. Tools and the settings namespace are the model-facing surface, not the engine. |
| **After uninstalling the plugin** | DS-Hns runs normally and loses only automatic restart. A pending `ticket.json` should be deleted (`scripts/uninstall.ps1` does this) so no supervisor acts on a request from a plugin that is gone. The audit log is preserved on purpose. |
| **After the *supervisor* is stopped** | Nothing changes for a running DS-Hns except that no restart can be observed; the plugin goes on refusing with `SUPERVISOR_ABSENT`. |

---

## Safety notes

Read these before installing.

- **Installing a plugin runs third-party code with your privileges.** A DSH plugin is
  ordinary Node.js loaded into the harness process. `dsh-restart` is no exception: it can
  read and write files in its state directory, and it is loaded with the same rights as
  DS-Hns itself. A git install additionally runs this package's `prepare` script at
  install time.
- **This plugin contains code that can reboot your machine.** `WindowsSystemShutdownPort`
  runs `shutdown.exe /r /t <delay> /d p:4:1` with `execFile` and no shell. It is reached
  only when `allowSystemReboot` **and** `systemRestart.enabled` are both true and the
  request itself sets `acknowledgeSystemReboot: true`. The default is **off** at all three
  gates. Be precise about the current state, though: in this release the port is
  constructed and exported, but **the request pipeline never calls it** — an accepted
  `mode: "system"` request writes a `mode: "system"` ticket and asks the *host* to shut
  down. See [Not implemented yet](#not-implemented-yet).
- **The helper scripts are not sandboxed.** `scripts/*.ps1` run with your rights, edit your
  profile's `cordis.patch.yml`, stop a supervisor process and delete a ticket file. Read
  them before running them; every one of them supports `-WhatIf`.
- **The ticket checksum is integrity, not authentication.** It detects a truncated or
  edited ticket without any shared secret. It does not prove who wrote it: anything that
  can write to the state directory can write a ticket that verifies. Protect that
  directory with filesystem permissions.
- **`safety.allowRestartWithoutSupervisor: true` converts accepted requests into probable
  outages.** It is off for a reason.
- **No network access.** The plugin makes no outbound connections: it reads and writes
  files, calls the host through injected ports, and (for pid liveness) runs local,
  read-only process queries (`tasklist.exe` / `ps`) with `execFile` and no shell.

---

## Documentation index

| Document | What is in it |
| --- | --- |
| [docs/architecture.md](docs/architecture.md) | the two-process picture, the trust boundary, both state machines, the ticket lifecycle |
| [docs/protocol.md](docs/protocol.md) | the wire protocol, the ticket document, the heartbeat, the ledger, versioning rules, a worked round trip |
| [docs/failure-modes.md](docs/failure-modes.md) | one section per failure mode: trigger, behaviour, what an operator sees, recovery |
| [docs/operations.md](docs/operations.md) | running, tuning, reading the audit log, recovering from safe mode, the PS scripts, log formats, directory layout |
| [docs/acceptance.md](docs/acceptance.md) | every acceptance criterion from the design document mapped to a named test, plus what needs a real Windows E2E run |
| [CONTRIBUTING.md](CONTRIBUTING.md) | build/test loop and the rules that must not be broken |
| [SECURITY.md](SECURITY.md) | threat model and responsible disclosure |
| [CHANGELOG.md](CHANGELOG.md) | release history |

## Development

```powershell
npm install
npm run build              # tsc -p tsconfig.json  -> lib/
npm test                   # build, then node --test tests/*.test.js
npm run test:only          # node --test tests/*.test.js  (no rebuild)
npm run typecheck          # tsc --noEmit
npm run verify:artifacts   # artifact checks against lib/ and bin/
npm run supervisor -- --help
```

`npm test` builds first, so a test run always exercises the current `src/`.
`verify:artifacts` asserts that `lib/` is a usable build: the entry point exposes the
Cordis contract and the library surface, no emitted file still imports a `.ts` specifier,
the protocol declaration ships, the documented cooldown resolves, invalid configuration
and an empty `allowedSources` are refused, every `SELF_REASON_CODES` value is usable, and
the supervisor entry point really prints usage.

---

## FAQ

**Will this reboot my machine?**
No, not in this release. The code that would (`WindowsSystemShutdownPort`) exists and is
exported, and it is gated by `allowSystemReboot` + `systemRestart.enabled` +
`acknowledgeSystemReboot`, all of which default to off. But the request pipeline never
calls that port, so an accepted `mode: "system"` request currently produces a ticket and a
host shutdown request, not a reboot. Do not rely on this plugin to reboot anything.

**What if the supervisor is not running?**
Nothing is relaunched, and the plugin refuses to restart on purpose. It answers
`SUPERVISOR_ABSENT` rather than exiting the process, because exiting with nobody to bring
it back is a shutdown, not a restart. Start the supervisor (see
[The supervisor](#the-supervisor)), or accept the trade by setting
`safety.allowRestartWithoutSupervisor: true`.

**Why was my request refused with `SUPERVISOR_ABSENT`?**
Because no supervisor heartbeat was seen inside `supervisor.heartbeatTimeoutMs` (30 s by
default). The check is the age of `<state>/heartbeat.json` on disk, so it fails when the
supervisor is not running, when it died, or when it was started with a different
`--state` directory than the plugin uses. Point both at the same directory — that mismatch
is the most common cause.

**How do I recover from safe mode?**
Fix the underlying crash first, then clear the flag:
`pwsh -File scripts/enable.ps1 -Mechanism SafeMode`, or edit `<state>/ledger.json` and set
`safeMode` to `false` (`enable.ps1` also clears `safeModeReason`/`safeModeAt`, and with
`-ClearHistory` empties `uncleanStarts`). The supervisor reads the ledger at startup and
stops relaunching while the flag is set, so clear it and make sure the supervisor is
running again.

**Does this save my tasks?**
No. This plugin has no access to task state and never writes any. It *asks* the harness to
prepare for a restart through the checkpoint port and believes only the answer; refusing
to restart when the answer is missing or unsafe is the whole design. Whatever saves and
restores your work is DS-Hns Core.

**Can the model restart the machine by calling a tool?**
It can *request* a restart, and the request goes through every check: source allow-list,
mode gate, `allowSystemReboot`, the request's own acknowledgement, the lock, the cooldown
and the checkpoint gate. A tool call has no privileged path and cannot bypass anything. In
this release it also cannot cause a reboot, because the reboot port is never invoked.

**Why does `restart_status` say `can_restart: false` with reason `RESTART_IN_FLIGHT` after
a restart was accepted?**
Because the lock stays in `SHUTTING_DOWN` until the process actually exits — and that
process is the one being asked to exit, so it stays non-idle for the rest of its life.
This is expected, not a stuck lock.

**Why was my request refused even though a restart just happened?**
Three different reasons look alike: the lock is still held (`RESTART_IN_FLIGHT`), the
cooldown has not elapsed (`COOLDOWN_ACTIVE`), or the same `requestId` was replayed with
different content (`DUPLICATE_REQUEST_ID`). Read `reason`, not just `accepted: false`.

**Is the cooldown remembered across restarts?**
No. Cooldown deadlines live in the process that accepted the restart, and a fresh process
starts with none. The bound is enforced for the life of the process that performed the
restart, not across the restart itself. Operators who need a hard cross-restart bound must
enforce it in the requester or in a wrapper. See
[Not implemented yet](#not-implemented-yet).

**What happens if the checkpoint port hangs?**
The gate gives it `safety.shutdownTimeoutMs` (90 s by default) and then treats it exactly
like any other checkpoint failure: the restart is aborted, the ticket is deleted, the lock
is released and the caller gets `CHECKPOINT_FAILED`. A hung checkpoint cannot leave the
lock stuck in `CHECKPOINTING`.

**Can I uninstall it without breaking DS-Hns?**
Yes. That is a design requirement, not an aspiration: the plugin registers one settings
namespace and three tools, and removing it removes all of them. `scripts/uninstall.ps1`
cancels a pending restart, stops the *supervisor* (and says so explicitly), removes the
registration, and preserves the audit log. DS-Hns runs on, minus automatic restart.

---

## Not implemented yet

Stated plainly, so nobody has to discover these by reading the source. Each is a
divergence from the design document:

- **System reboot is wired, and gated three times.** An accepted `mode: "system"` request
  calls the system-shutdown port after writing its ticket, and a machine with no port
  refuses the request outright rather than quietly downgrading it to an application
  restart. The port itself runs `shutdown.exe` without a shell.
- **A hung shutdown is bounded.** The supervisor gives the host `safety.shutdownTimeoutMs`
  to exit and then abandons the restart, recording why. With `safety.allowForceTerminate`
  on **and** a terminator injected it ends the process instead and records the restart as
  dirty. The shipped `bin/supervisor.mjs` injects a terminator only when that setting is
  on, so the default supervisor is physically unable to kill anything.
- **`acknowledgeResume` is called automatically.** The supervisor invokes it the moment a
  relaunch is observed alive, so the harness learns that its checkpoint was consumed. A
  failing acknowledgement is logged, not fatal.
- **Relaunch retries are paced.** A failed launch is retried with a doubling
  `supervisor.relaunchBackoffMs` up to `relaunchBackoffMaxMs`, on top of the crash-loop
  breaker.
- **The plugin reads the supervisor's ledger.** `ledger.json`'s `safeMode` flag is folded
  into the plugin's own `CRASH_LOOP` refusal, so a crash loop the supervisor discovered is
  visible to the process that would otherwise keep asking for restarts.
- **Safe mode stops automation; it does not launch a degraded DS-Hns.** The design
  describes entering safe mode by launching DS-Hns without restart-plugin automation. What
  the supervisor does is stop relaunching. If it tripped the breaker because the process
  was already gone, DS-Hns stays down until a human starts it — the log line "DS-Hns still
  runs" is accurate only for the case where DS-Hns is up and the *plugin* is the problem.
- **The plugin does not start the supervisor.** `spawnSupervisor()` is exported but never
  called, so the supervisor must be started by a wrapper, the Task Scheduler, or
  `scripts/install.ps1`.
- **The supervisor does not read the profile configuration.** `bin/supervisor.mjs` calls `resolveConfig()` with no overrides, so it always runs on the shipped defaults plus its own command line. Profile-level tuning of `supervisor.*` therefore changes what the *plugin* expects (for example its heartbeat timeout) but not what the supervisor does — a mismatch that shows up as spurious `SUPERVISOR_ABSENT` refusals. Pass `--tick-ms`, or accept the defaults on both sides.
- **`supervisor.detach` is documentation-only.** It is declared, defaulted and validated, but only the never-called `spawnSupervisor()` reads it; the actual relaunch launcher hard-codes `detached: false`, so detaching is the operator's job.
- **`supervisor.log` is never rotated.** It is append-only and grows without bound; only the audit log honours `storage.maxLogBytes`.
- **`SHUTDOWN_TIMEOUT` is declared but never raised by the plugin.** The supervisor reports
  the same condition as `SHUTDOWN_ABANDONED` and `shutdown_abandoned` in its own log, so the
  plugin-side code remains reserved.
- **Cooldowns, the duplicate ledger and the crash-loop view are per-process.** None is persisted, so none survives the restart it gates.
- **Relaunch verification is by pid liveness, not by an application heartbeat.** The
  state is named `WAITING_FOR_HEARTBEAT`, but what it checks is whether the relaunched pid
  is alive; the only heartbeat file is the supervisor's own.
- **No Windows E2E evidence in this repository.** The design's end-to-end matrix needs a
  real machine; see [docs/acceptance.md](docs/acceptance.md#what-needs-a-real-windows-e2e-run).

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 dsh-restart contributors.

This is a **community plugin**. It is not affiliated with, endorsed by, or supported by
DeepSeek. "DeepSeek Harness" and "DS-Hns" refer to the host application this plugin is
written for; all trademarks belong to their respective owners.
