# Operations

How to run, watch, tune and recover `dsh-restart`. Everything here is the behaviour of the code in
this repository; where the design document and the source disagree, the source is described and the
divergence is called out.

Related reading: [`../README.md`](../README.md), [`architecture.md`](architecture.md),
[`protocol.md`](protocol.md), [`acceptance.md`](acceptance.md), [`failure-modes.md`](failure-modes.md).

---

## Running

The supervisor is a separate long-lived process that runs **around** DS-Hns. It owns the pid watch, the ticket, the relaunch and the crash-loop breaker; the plugin owns request validation, the checkpoint gate, the ticket and the graceful-shutdown request.

```powershell
node bin/supervisor.mjs --state "$env:DSH_HOME\restart" --pid 4242 --tick-ms 1000 --max-ticks 3 `
  --terminate-after-verify -- node dsh.js --profile web
```

| Option | Meaning |
| --- | --- |
| `--state <dir>` | Directory holding `ticket.json`, `heartbeat.json` and `ledger.json`. Defaults to `%DSH_HOME%\restart`, else `./.dsh-restart`. |
| `--pid <pid>` | Watch this pid instead of the parent process. **Required for a detached start** — see below. |
| `--tick-ms <ms>` | Poll interval. Defaults to `supervisor.pollIntervalMs` (1000 ms). |
| `--max-ticks <n>` | Stop after `n` ticks. Intended for a bounded run or a smoke test; production passes neither this nor `--tick-ms` and stops on a terminal state. |
| `--terminate-after-verify` | Exit after a relaunch is verified, instead of resuming monitoring. |
| `-h`, `--help` | Print usage and exit 0. |
| `-- <command> [args…]` | Everything after `--` is the command used to relaunch DS-Hns. |

**Why it must be detached, and why that forces `--pid`.** The supervisor must outlive the process it watches, so it cannot be a child that dies with its parent: `spawnSupervisor()` starts it with `detached: true`, `stdio: 'ignore'` and `child.unref()`, and its own timers are `unref`'d so it can never hold a host open. But a detached start has no meaningful parent, and `RestartSupervisor` defaults `watchedPid` to `process.ppid`. **Without an explicit `--pid`, a detached supervisor watches its launcher (or a pid that has already exited), not DS-Hns.** Pass `--pid`.

**The caveat that bites.** Without `--`, `deriveLaunchSpec()` falls back to the supervisor's own `argv`, which is `bin/supervisor.mjs` itself, not DS-Hns. A supervisor started without `--` will relaunch *itself* after every exit. This was verified, and it is the single most important deployment caveat here. `scripts/install.ps1` warns about it too: `note: no -LaunchCommand was given, so the supervisor will fall back to its own argv, which is this script path rather than DS-Hns. Pass -LaunchCommand <exe>,<args...> for a working relaunch.`

The supervisor mirrors every log line to **stderr** as well as to `supervisor.log`, so a wrapper or the Task Scheduler can see safe mode without reading the file. It exits **3** when it ends in safe mode, so "a human must look at this" is distinguishable from both success and a crash.

A supervisor started from the CLI calls `resolveConfig({})`: it does **not** read the profile's plugin configuration, so `supervisor.launchCommand`, `launchArgs`, `launchCwd` and the timing keys are at their shipped defaults. Give it `--` and accept the defaults. See [`failure-modes.md`](failure-modes.md#9-config-rejected-at-load).

---

## State directory layout

Both sides must name the **same** directory, or the plugin will never see a heartbeat and will refuse every request with `SUPERVISOR_ABSENT`. The plugin defaults to `<DSH_HOME>\restart` (`storage.directory` overrides it); the supervisor defaults to `--state`, else `<DSH_HOME>\restart`, else `./.dsh-restart`.

| File | Written by | When | Safe to delete? |
| --- | --- | --- | --- |
| `ticket.json` | The plugin (`TicketStore.writeTicket`, atomic) | After the checkpoint gate passes and before the shutdown request; deleted as soon as the supervisor consumes it, the request is aborted or cancelled, or a new plugin start reconciles it | Yes, and that is exactly what cancels a pending restart. It is the one file a supervisor acts on. |
| `heartbeat.json` | The supervisor (`HeartbeatWriter`, atomic, every `heartbeatIntervalMs` and on every state change) | While the supervisor runs | Yes. The plugin then reads the supervisor as absent until the next beat, and refuses with `SUPERVISOR_ABSENT`. |
| `ledger.json` | The supervisor (`persistLedger()`; also edited by `enable.ps1` / `disable.ps1`) | On every relaunch, every unclean start and safe-mode transition | Yes, but you lose the crash history and any `safeMode` flag. Deleting it *is* a way to clear safe mode — it is what `enable.ps1 -Mechanism SafeMode` edits. |
| `supervisor.log` | The supervisor (`bin/supervisor.mjs`, one JSON object per line, append-only) | Every event | Yes. It is a log with no rotation: nothing else reads it, and it grows unbounded. |
| `restart-attempts.jsonl` | The plugin (`RestartAuditLog`, append-only) | Every accepted, refused, aborted and cancelled attempt | Only if you want to lose the incident trail. Operationally safe: the plugin appends without reading back. |
| `restart-attempts.jsonl.<timestamp>.bak` | The plugin, when the log reaches `storage.maxLogBytes` | At rotation | Yes, with the same caveat. `uninstall.ps1` deliberately preserves these. |

The plugin's own state directory resolves as `<DSH_HOME>/restart`, falling back to `<cwd>/.dsh-restart` — the same default the supervisor uses, which is why `%DSH_HOME%` is usually the only thing you have to set consistently.

---

## The PowerShell scripts

All four are comment-based-help advanced scripts that support `-WhatIf` (`[CmdletBinding(SupportsShouldProcess)]`), refuse to guess rather than write something they cannot verify, and exit non-zero when they refuse. A refusal means **nothing was written where the problem was reported**.

> **Environment note.** All four scripts declare `#Requires -Version 5.1`. Nothing in
> them uses a PowerShell 7-only feature, and Windows PowerShell 5.1 ships with every
> supported Windows version, so 5.1 is the widest requirement that is still truthful —
> and it is the version that was used to validate them. PowerShell 7 was **not**
> installed on the machine where they were validated, so every case below was executed
> under Windows PowerShell 5.1: parsing under both the file parser and `Get-Command`,
> the idempotent re-install, `-WhatIf` for all four scripts, precondition-failure exit
> codes, ticket cancellation with audit-log preservation, both `enable`/`disable`
> mechanisms, and the refusal paths. `tests/integration.test.js` repeats the parse and
> the `-WhatIf` precondition check on every run. They have **not** been executed under
> 7.0, which is a gap worth closing on a machine that has it.

<details>
<summary><code>install.ps1</code> — register, verify, optionally start the supervisor, smoke test</summary>

**What it does, in order.** (1) Preconditions: `package.json`, `bin/supervisor.mjs` and `lib/index.js` must exist under `-RepoPath`, and the dsh and node executables must resolve. (2) It asks the profile whether the plugin is already registered by dumping the composed profile — an **idempotent** check that happens *before* any write, so running it twice installs once and says so. (3) It registers with `dsh plugin --profile <Profile> add <RepoPath>` and re-dumps the profile to verify. (4) It optionally creates the state directory and starts the supervisor detached and hidden. (5) It smoke-tests `node bin/supervisor.mjs --help`, requiring exit 0 *and* usage text.

| Parameter | Default | Purpose |
| --- | --- | --- |
| `-Profile <string>` | `web` | DSH profile to install into. |
| `-RepoPath <string>` | parent of `scripts/` | The package directory. |
| `-StateDirectory <string>` | `$env:DSH_HOME\restart`, else `<RepoPath>\.dsh-restart` | Passed to the supervisor as `--state`. |
| `-LaunchCommand <string[]>` | none | Everything after `--` on the supervisor command line, e.g. `node,'D:\DS-Hns\app\dsh.js','--profile','web'`. |
| `-WatchPid <int>` | none | Passed as `--pid <n>`. |
| `-SkipSupervisor` | off | Register and verify only; the summary prints the exact command to start it later. |
| `-SkipVerification` | off | Do not run `--dump-config`; the install is reported as `verified: no`. |
| `-DshCommand <string[]>` | `@('dsh')` | The dsh executable plus any prefix arguments. |
| `-NodePath <string>` | `node` | Node used for the supervisor and the smoke test. |
| `-WhatIf` | off | Print every action, change nothing. |

**What it refuses to guess.** A missing dsh or node executable, a missing `package.json`, `bin/supervisor.mjs` or `lib/index.js`, and — the important one — an unreadable profile, for which it prints `FAIL: could not determine whether dsh-restart is registered (dsh --dump-config exited 1: ...)`, then `Nothing was changed: registering on an unknown state is how a profile ends up with the plugin twice. Fix the profile first, or pass -SkipVerification to register without asking.`

It never stops DS-Hns and never reboots anything. The real summary output ends:

```text
  state directory : D:\DS-Hns\temp\dsh-restart-script-test-c478835a1ed44dc4a6aca1fceddb28b1\state
  verified        : yes
  supervisor      : not started by this script
  smoke test      : passed
```

</details>

<details>
<summary><code>uninstall.ps1</code> — cancel, stop the <em>supervisor</em>, remove, preserve the audit log</summary>

**What it does, in order.** (1) Deletes `<StateDirectory>\ticket.json`, so no supervisor can act on a pending restart. (2) Identifies the supervisor **from `heartbeat.json`** and stops that process only. (3) Runs `dsh plugin --profile <Profile> remove dsh-restart`. (4) Prints every state file it preserved.

| Parameter | Default | Purpose |
| --- | --- | --- |
| `-Profile <string>` | `web` | Profile to remove the plugin from. |
| `-StateDirectory <string>` | `$env:DSH_HOME\restart`, else `<RepoPath>\.dsh-restart` | Where the ticket, heartbeat, ledger and audit log live. |
| `-RepoPath <string>` | parent of `scripts/` | Used to recognise the supervisor's command line. |
| `-KeepTicket` | off | Do not delete a pending ticket (only when handing it to a supervisor that should act on it). |
| `-SkipSupervisor` | off | Do not stop the supervisor process. |
| `-SkipPluginRemoval` | off | Clean up runtime state without touching the profile. |
| `-DshCommand <string[]>` | `@('dsh')` | The dsh executable plus any prefix arguments. |
| `-Force` | off | Stop the pid even when its command line does not name `supervisor.mjs`. |
| `-WhatIf` | off | Print every action, change nothing. |

**It stops the supervisor only, never DS-Hns.** The refusal is explicit, and it is the script's most important behaviour: `FAIL: pid 999999 looks like the DS-Hns harness, not the supervisor; refusing to stop it`. A pid is stopped only when its command line matches `supervisor\.mjs`, or when `-Force` is given. It **preserves the audit log**, and says so:

```text
==> Preserving the audit log
    PRESERVED (not deleted, not rotated, not truncated):
      D:\DS-Hns\temp\...\state\restart-attempts.jsonl (57 bytes)
      D:\DS-Hns\temp\...\state\heartbeat.json (184 bytes)
    note: the state directory itself is left in place: D:\DS-Hns\temp\...\state
    note: delete it by hand only if you also want to lose the incident trail

  DS-Hns was not stopped, signalled or modified. It keeps running; what it loses is automatic restart.
```

**What it refuses to guess.** A heartbeat that is not readable JSON, a heartbeat with no usable
`supervisorPid` ("refusing to guess which process to stop"), and any pid that does not look like the
supervisor. It also never uses `taskkill` and never issues `shutdown /r`.

</details>

<details>
<summary><code>enable.ps1</code> / <code>disable.ps1</code> — two independent mechanisms</summary>

Both scripts toggle exactly two mechanisms and print which mechanism and which file they used.

| Mechanism | The file it edits | What it changes |
| --- | --- | --- |
| `Plugin` | `<ProfileDirectory>\cordis.patch.yml`, in the region belonging to this plugin — a row with `id: restart` or `name: 'dsh-restart'` | `enabled: true` / `enabled: false` inside that row. This is the plugin's master switch: while false, every request is refused with `DISABLED`. |
| `SafeMode` | `<StateDirectory>\ledger.json` | `safeMode` (plus `safeModeReason` and `safeModeAt`). While true, the supervisor refuses to relaunch anything, even if a ticket appears. |

`-Mechanism Plugin|SafeMode|Both` — `Both` is the default. The two mechanisms are **independent**: clearing safe mode does not re-enable a disabled plugin, and vice versa. Neither starts the supervisor.

```powershell
pwsh -File scripts/enable.ps1                                     # clear safe mode + enabled: true
pwsh -File scripts/enable.ps1 -Mechanism SafeMode -ClearHistory   # also empty uncleanStarts
pwsh -File scripts/enable.ps1 -Mechanism Plugin -AllowCreate      # append the row if absent
pwsh -File scripts/disable.ps1 -Mechanism SafeMode -Reason 'thermal incident 2026-06-01'
pwsh -File scripts/disable.ps1 -WhatIf                            # change nothing
```

| Parameter | Script | Default | Purpose |
| --- | --- | --- | --- |
| `-Mechanism` | both | `Both` | `Plugin`, `SafeMode` or `Both` (`ValidateSet`). |
| `-Profile` | both | `web` | Profile whose `cordis.patch.yml` is edited. |
| `-ProfileDirectory` | both | `$env:DSH_HOME\profiles\<Profile>` | Used when the directory cannot be derived. |
| `-StateDirectory` | both | `$env:DSH_HOME\restart`, else `<RepoPath>\.dsh-restart` | Holds `ledger.json`. |
| `-RepoPath` | both | parent of `scripts/` | Fallback for the state directory. |
| `-ClearHistory` | enable | off | With `SafeMode`, also empty `uncleanStarts`. |
| `-AllowCreate` | both | off | With `Plugin`, create/append the patch row instead of refusing. |
| `-Reason` | disable | `manual_disable_by_operator` | The `safeModeReason` recorded in the ledger. |
| `-WhatIf` | both | off | Print what would change, write nothing. |

**What they refuse to guess.** A ledger that is missing (`enable` refuses: "the supervisor has never run, so there is no safe-mode flag to change"), unreadable JSON, a JSON non-object, or a document with neither `safeMode` nor `schemaVersion`; a patch with **more than one** row for this plugin ("refusing to guess which one to edit"); a row with neither a `config:` block nor an `enabled:` key; and — when `-AllowCreate` is absent — a patch with no row at all: `FAIL: no row for this plugin in ...\profiles\web\cordis.patch.yml; expected a line like '- id: restart' or "- name: 'dsh-restart'"`, followed by `note: pass -AllowCreate to append such a row instead of refusing`.

Both scripts write UTF-8 **without a BOM** on purpose: a BOM would make the ledger unparseable by the supervisor's reader, which would look like "no ledger" and silently re-arm automatic restart. They also finish with the reminder that matters:

```text
  Configuration changes take effect on the next profile load: this script does not
  reload the running profile, and the plugin does not hot-swap its safety bounds.
  Safe mode is cleared for the SUPERVISOR: if it is not running, nothing will relaunch DS-Hns.
```

</details>

---

## Recovering from safe mode

Safe mode is the supervisor having stopped relaunching after the crash-loop breaker tripped. DS-Hns keeps running; what is gone is the automatic relaunch. **Fix the underlying problem first** — safe mode is a brake, not a fault.

```powershell
# 1. See where it stands.
Get-Content "$env:DSH_HOME\restart\ledger.json"
Select-String -Path "$env:DSH_HOME\restart\supervisor.log" -Pattern 'safe_mode|crash_loop'

# 2. Clear the flag, and the crashes that accumulated while it was set.
pwsh -File scripts/enable.ps1 -Mechanism SafeMode -ClearHistory

# 3. Clearing safe mode does NOT start the supervisor. Start it:
node bin/supervisor.mjs --state "$env:DSH_HOME\restart" --pid 4242 -- node dsh.js --profile web
```

The ledger **before**, after a real crash loop:

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

The ledger **after** — this is real output from the script test run, which printed `==> Clearing the crash-loop safe-mode flag in the ledger` and `done: cleared safeMode in ...\state\ledger.json (was True)`:

```json
{
  "schemaVersion":  1,
  "uncleanStarts":  [
                        {
                            "at":  "2026-06-01T08:59:00.000Z",
                            "reason":  "process_died_without_ticket"
                        }
                    ],
  "safeMode":  false,
  "safeModeReason":  null,
  "safeModeAt":  null,
  "relaunches":  2
}
```

(That capture was taken with `-ClearHistory` omitted, so one `uncleanStarts` entry remained. With `-ClearHistory` the array is emptied as well.) `disable.ps1` is the inverse: it records `safeModeReason: "manual_disable_by_operator"` and a fresh `safeModeAt`.

---

## Configuration reference

Every key is deep-merged over `DEFAULT_CONFIG` and then validated by `resolveConfig()`. A document
that cannot be enforced is **rejected, never repaired** — the plugin reports it and runs on the
defaults; the supervisor reports it and exits non-zero.

<details>
<summary>Every key, its default, its effect and the risk of changing it</summary>

| Key | Type | Default | Effect | Risk of changing it |
| --- | --- | --- | --- | --- |
| `enabled` | boolean | `true` | Master switch for restart execution; false refuses every request with `DISABLED` | Silently removes the ability to restart at all — exactly what a degraded host may be asking for |
| `applicationRestart.enabled` | boolean | `true` | Whether an application restart may happen | Off leaves no automatic recovery path; on is intended, because the process is expected to come back |
| `applicationRestart.minIntervalMs` | number ≥ 0 | `1200000` (20 min) | Hard lower bound between two application restarts; an earlier request is refused, not queued | Too small permits a restart storm; too large makes an operator wait through an incident |
| `systemRestart.enabled` | boolean | `false` | First of three independent gates on an OS reboot | Enabling it is what lets a request end every other program on the machine |
| `systemRestart.minIntervalMs` | number ≥ 0 | `3600000` (60 min) | Lower bound between two system restarts | Too short and a failing machine can be rebooted repeatedly |
| `allowedSources` | string[] | `dsh-health-scheduler`, `dsh-cli`, `operator` | Sources permitted to submit; anything else is `UNKNOWN_SOURCE` | Adding a source grants it the ability to end the process; must not be empty |
| `allowedPriorities` | string[] | `low`, `normal`, `high`, `emergency` | Vocabulary filter; priority never bypasses a check | Narrowing it makes a requester fail with `INVALID_REQUEST` rather than being deprioritized |
| `allowSystemReboot` | boolean | `false` | Second gate on a reboot; the request's own acknowledgement is the third | With this and the mode enabled, an acknowledged request may reboot the machine |
| `safety.checkpointRequired` | boolean | `true` | Whether a request that asks for a checkpoint must get one | False lets a restart proceed with no confirmation of a safe point — the one thing the design forbids |
| `safety.duplicateSuppression` | boolean | `true` | Whether a replayed `requestId` returns the previous answer instead of acting | Off makes a retrying requester able to submit twice; the lock and cooldown become the only defences |
| `safety.crashLoopLimit` | number ≥ 1 | `3` | Unclean starts inside the window that trip the breaker | Low sends a machine with one flaky crash into safe mode; high lets a real crash loop keep relaunching |
| `safety.crashLoopWindowMs` | number > 0 | `600000` (10 min) | Rolling window for those starts | Short lets a slow crash loop evade the breaker; long accumulates unrelated crashes into a trip |
| `safety.safeModeOnLoop` | boolean | `true` | Whether tripping the breaker also enters safe mode | False still refuses to relaunch past the limit, but records no `safeMode` flag, so an operator has less to go on |
| `safety.shutdownTimeoutMs` | number > 0 | `90000` | Budget for the **checkpoint** call; it is *not* a watchdog over the host's exit | Setting it low abandons slow checkpoints; it does not make a hung shutdown time out (see case 4) |
| `safety.allowForceTerminate` | boolean | `false` | Allow ending a process that ignored its graceful shutdown, after `shutdownTimeoutMs` | Read by the supervisor, which then needs a bound `ProcessTerminator`. `bin/supervisor.mjs` binds one only when this is `true`, so the default supervisor cannot kill anything. Changing it has no effect in this release |
| `safety.allowRestartWithoutSupervisor` | boolean | `false` | Whether a restart may be attempted with no heartbeat | True converts every accepted request into a probable outage: exiting is not restarting |
| `supervisor.heartbeatIntervalMs` | number > 0 | `5000` | Supervisor beat interval, read by both sides | A long interval makes the plugin declare the supervisor absent between beats |
| `supervisor.heartbeatTimeoutMs` | number > 0 | `30000` | Age after which the supervisor counts as absent | A short timeout makes a busy machine refuse legitimate restarts |
| `supervisor.relaunchTimeoutMs` | number > 0 | `90000` | How long the supervisor waits for a relaunched pid to be alive, and the delay between retries | Too short counts a slow but healthy start against the breaker |
| `supervisor.launchCommand`, `.launchArgs`, `.launchCwd` | string[] / string or `null` | `null`, `[]`, `null` | Relaunch command, extra arguments, working directory; `launchCommand: null` means "reuse the supervisor's argv" | A wrong value relaunches the wrong program or resolves a relative profile path somewhere unexpected; the CLI supervisor never reads these keys at all |
| `supervisor.pollIntervalMs` | number > 0 | `1000` | How often the supervisor polls for the exit | Very small polls the process list constantly; large delays the relaunch after a clean exit |
| `supervisor.ticketTtlMs` | number > 0 | `600000` (10 min) | How long a pending ticket stays valid | Too short and a late-starting supervisor voids a legitimate ticket; too long and an old ticket can be honoured after the fact |
| `supervisor.detach` | boolean | `true` | Intended to run the supervisor detached | **Validated, and read only by `spawnSupervisor()`**, which this package never calls; `ChildProcessLauncher` hard-codes `detached: false` |
| `storage.directory` | string or `null` | `null` | Directory override for the audit log; `null` means "the same directory as the ticket, heartbeat and ledger" | Pointing it at a temporary path loses the trail; a read-only path makes audit writes fail |
| `storage.maxLogBytes` | number > 0 | `4194304` (4 MiB) | Size at which `restart-attempts.jsonl` rotates to `<path>.<timestamp>.bak` | Large grows disk usage unattended; small scatters the trail across many `.bak` files |
| `storage.maxRecentAttempts` | number ≥ 1 | `25` | How many attempts the status call keeps in memory | Only affects what `restart_status` shows; the on-disk log keeps more |
| `knownReasonCodes` | string[] | nine codes | Reason codes accepted without complaint | Documentation for operators, not an authorization list: an unknown code is logged, not refused |

</details>

**The three cross-field constraints `resolveConfig()` enforces.** Each is a refusal at load time, with the offending dotted path named:

| Constraint | Real error string |
| --- | --- |
| `supervisor.heartbeatTimeoutMs` **must exceed** `supervisor.heartbeatIntervalMs` | `dsh-restart config: supervisor.heartbeatTimeoutMs must exceed supervisor.heartbeatIntervalMs (60000), received 30000` |
| `supervisor.relaunchTimeoutMs` **≥** `supervisor.heartbeatIntervalMs` | `dsh-restart config: supervisor.relaunchTimeoutMs must be at least supervisor.heartbeatIntervalMs (5000)` — composed by `config.ts`; the captured run that meant to exercise it tripped the heartbeat constraint first |
| `allowedSources` **must be non-empty** | `dsh-restart config: allowedSources must list at least one source; an empty list would refuse every request, including an operator request` |

Two adjacent validations are worth knowing as well, because they are silent: `tryResolveConfig({ enabled: 'yes' })` reports `dsh-restart config: enabled must be a boolean, received "yes"` and then **falls back to `enabled: true`**; and `crashLoopLimit` is coerced with `Math.max(1, Math.trunc(...))`, so `0` becomes `1` rather than an error.

---

## Tuning guidance

<details>
<summary>Slow machine</summary>

The failure signature is a healthy supervisor being declared absent, or a slow start being counted against the breaker. Raise the budgets together:

```yaml
supervisor:
  heartbeatIntervalMs: 15000     # from 5000
  heartbeatTimeoutMs: 60000      # must stay above heartbeatIntervalMs
  relaunchTimeoutMs: 180000      # from 90000; must be >= heartbeatIntervalMs
  pollIntervalMs: 5000           # from 1000; a busy machine does not need 1 Hz polling
```

Keep `heartbeatTimeoutMs` at least three beats above `heartbeatIntervalMs`, and remember that `relaunchTimeoutMs` is also the delay between relaunch retries — raising it slows the crash loop's own detection.

</details>

<details>
<summary>Machine where restarts must be rare</summary>

Make the request path refuse early rather than queue, and let the breaker trip sooner:

```yaml
applicationRestart:
  minIntervalMs: 3600000         # from 1200000: one application restart per hour
safety:
  crashLoopLimit: 2              # from 3: trip after two unclean starts
  crashLoopWindowMs: 1800000     # from 600000: a wider window catches slow loops
  allowRestartWithoutSupervisor: false   # keep this false
```

Raising `minIntervalMs` only changes the *refusal* threshold: the plugin has no queue, so a request inside the cooldown is refused with `COOLDOWN_ACTIVE`, not deferred. If a requester must not be refused, that is a scheduling decision and belongs to `dsh-health-scheduler`, not here.

</details>

<details>
<summary>Deployment with no checkpoint port</summary>

The shipped default is the `UnboundCheckpointPort`, which reports `safe: false` and makes every request with `checkpointRequired: true` fail with `CHECKPOINT_FAILED`. Three options, best first:

1. **Bind a real port.** `FunctionCheckpointPort` if the harness can call into the plugin; `FileCheckpointPort` if the host can only publish a readiness document — it reads `{ "safe": true, "reason": "idle", "checkpoint_id": "ck-42", "resume_token": "rs-7" }`, and by default treats a file older than 60 s as stale.
2. **Ask for a checkpoint only when one exists.** Leave `safety.checkpointRequired: true` and have the requester send `checkpointRequired: false` for restarts that genuinely do not need one. The gate then authorizes without a checkpoint, and the outcome detail says so.
3. **Turn the gate off globally** with `safety.checkpointRequired: false`. This removes the design's core guarantee for every request, so it is the last resort, not the first.

Until one of these is done, expect `restart_status` to report `"capabilities": { "checkpointPort": false }` and every request to be refused.

</details>

---

## Reading the audit log

`restart-attempts.jsonl` is append-only, one JSON object per line, in this envelope:

```json
{"schemaVersion":1,"kind":"restart-attempt","record":{ ... }}
```

`record` is a `RestartAttemptRecord`: `requestId`, `ticketId` (`null` when nothing was written), `mode`, `source`, `reasonCode`, `state`, `startedAt`, `finishedAt`, `detail`, `clean`, `outcomeCode`. Two real lines, both refusals:

```json
{"schemaVersion":1,"kind":"restart-attempt","record":{"requestId":"req-from-nowhere","ticketId":null,"mode":"application","source":"some-random-app","reasonCode":"OPERATOR_REQUEST","state":"rejected","startedAt":"2026-06-01T09:00:00.000Z","finishedAt":"2026-06-01T09:00:00.000Z","detail":"source \"some-random-app\" is not allowed; allowed sources: dsh-health-scheduler, dsh-cli, operator","clean":true,"outcomeCode":"UNKNOWN_SOURCE"}}
{"schemaVersion":1,"kind":"restart-attempt","record":{"requestId":"tool-1780000300000-119284","ticketId":null,"mode":"application","source":"dsh-cli","reasonCode":"OPERATOR_REQUEST","state":"rejected","startedAt":"2026-06-01T09:05:00.000Z","finishedAt":"2026-06-01T09:05:00.000Z","detail":"another restart is already in progress","clean":true,"outcomeCode":"RESTART_IN_FLIGHT"}}
```

**Accepted, refused, aborted and cancelled attempts are all recorded.** An accepted application restart is written *before* the response is returned, so an operator reading the log always sees why the process is about to disappear; its record uses `state: "shutting_down"`, `outcomeCode: "ACCEPTED"`, and a detail composed as `<response detail> (checkpoint <id|none>, reason <reasonCode>)` — for example `application restart accepted: the host is shutting down and the supervisor will relaunch it (checkpoint ck-2026-06-01T09-00-00, reason OPERATOR_REQUEST)`. Aborts use `state: "failed"` with `CHECKPOINT_FAILED`, `CHECKPOINT_REQUIRED`, `TICKET_WRITE_FAILED` or `SHUTDOWN_PORT_UNAVAILABLE`; cancellations use `state: "cancelled"` with `outcomeCode: "CANCELLED"` and the detail `the requester cancelled the pending restart`.

Reading it safely:

- **Rotation.** When the file reaches `storage.maxLogBytes` (default 4 MiB) it is renamed to a `.bak` file whose name carries an ISO timestamp with the `:` and `.` characters replaced by `-` (so `restart-attempts.jsonl.2026-06-01T09-05-00-000Z.bak`), and a fresh empty file is created. Reads do not follow the `.bak` files; concatenate them yourself if you need the whole trail.
- **A half-written trailing line is expected** after a hard kill, and is tolerated: a line that does not parse as JSON is skipped, and a record is only accepted when `kind` is `restart-attempt` **and** `schemaVersion` is `1`. Nothing is ever truncated or repaired in place.
- **A write failure is swallowed**, counted in `RestartAuditLog.writeFailures` and exposed as `lastError`. Neither is surfaced in the `restart_status` payload in this release, so a full or read-only directory shows up as a *missing* audit line rather than an error.

```powershell
# The last five recorded attempts, newest last.
Get-Content "$env:DSH_HOME\restart\restart-attempts.jsonl" -Tail 5 | ForEach-Object {
  $r = ($_ | ConvertFrom-Json).record
  '{0}  {1,-10} {2,-14} {3}' -f $r.finishedAt, $r.state, $r.outcomeCode, $r.detail
}
```

---

## Log formats

### `supervisor.log`

One JSON object per line, also mirrored to **stderr**. Every field is always present; `detail` is omitted when there is none.

| Field | Meaning |
| --- | --- |
| `timestamp` | ISO-8601 instant. |
| `state` | One of `MONITORING`, `WAITING_FOR_EXIT`, `RELAUNCHING`, `WAITING_FOR_HEARTBEAT`, `VERIFIED`, `CRASH_LOOP`, `SAFE_MODE`, `STOPPED`. |
| `code` | Machine-readable event code, for grepping. |
| `message` | Human-readable line. |
| `detail` | Optional object with event-specific fields. |

The normal restart, in order:

```json
{"timestamp":"2026-06-01T09:00:05.000Z","state":"MONITORING","code":"supervisor_started","message":"watching pid 4242","detail":{"supervisorPid":28868,"directory":"D:\\DS-Hns\\temp\\docs-sup-ok-lc9Gu6"}}
{"timestamp":"2026-06-01T09:00:05.000Z","state":"WAITING_FOR_EXIT","code":"restart_ticket_accepted","message":"restart_ticket_accepted","detail":{"ticketId":"application-1780304400000-1-e2efb725","mode":"application","pid":4242}}
{"timestamp":"2026-06-01T09:00:05.000Z","state":"RELAUNCHING","code":"relaunching","message":"relaunching","detail":{"reason":"expected_exit_observed"}}
{"timestamp":"2026-06-01T09:00:05.000Z","state":"WAITING_FOR_HEARTBEAT","code":"relaunched","message":"relaunched","detail":{"pid":10002}}
{"timestamp":"2026-06-01T09:00:05.000Z","state":"VERIFIED","code":"relaunch_verified","message":"relaunch_verified","detail":{"pid":10002}}
{"timestamp":"2026-06-01T09:00:05.000Z","state":"MONITORING","code":"monitoring_resumed","message":"monitoring_resumed","detail":{"pid":10002}}
```

`bin/supervisor.mjs` brackets a run with `supervisor_boot` (which carries `supervisorPid` and the parsed `launch` array) and `supervisor_stopped` (which carries the whole run result: `state`, `reason`, `relaunches`, `safeMode`). Event codes to grep for during an incident:

| Code | Meaning |
| --- | --- |
| `restart_ticket_accepted` | A verifiable ticket was found; the supervisor is now waiting for the exit. |
| `discarded_unverifiable_ticket` | A ticket failed verification and was deleted; `detail.rejection` says why. |
| `adopted_ticket_pid` | The ticket named a different pid than the one being watched; the ticket won. |
| `process_died_without_ticket` | The watched pid is gone with no ticket; counted as an unclean start. |
| `no_launch_command` | Nothing could be derived to relaunch; safe mode. |
| `relaunch_failed` | The launch itself failed; counted against the breaker. |
| `relaunch_verification_failed` | The relaunched pid is not alive after `relaunchTimeoutMs`. |
| `crash_loop_limit_reached` | The breaker tripped. |
| `safe_mode_entered`, `safe_mode_manual_action_required` | Automation stopped; a human is needed. |

### Exit codes

| Code | Meaning | When |
| --- | --- | --- |
| `0` | Success: the run ended normally | `--help`; a bounded run that hit its tick limit (`supervisor_stopped`, reason `TICK_LIMIT`); a run that ended after a verified relaunch with `--terminate-after-verify` |
| `1` | The supervisor itself failed | An unknown option (`unknown supervisor option: --nope`), or a fatal error in `main()` |
| `2` | It could not create the state directory | `--state <file>/sub` where `<file>` is not a directory: `supervisor: cannot create state directory <dir>: <error>` |
| `3` | A human must look at this: safe mode, or the run ended with reason `CRASH_LOOP` | A tripped breaker in `ledger.json` (`SAFE_MODE`, `CRASH_LOOP`) |

---

## Health checks an operator can run

```powershell
# 1. The entry point exists, runs, and prints usage. Exit 0 plus "Usage:" text.
node bin/supervisor.mjs --help

# 2. Is the supervisor alive, and what is it watching? A stale timestamp means absence:
#    the plugin declares it absent past supervisor.heartbeatTimeoutMs (30 s by default).
Get-Content "$env:DSH_HOME\restart\heartbeat.json"
# {"schemaVersion":1,"supervisorPid":28868,"watchedPid":10002,"state":"MONITORING","timestamp":"2026-06-01T09:00:05.000Z","sequence":7}

# 3. Is the installation sound? Builds nothing; checks the emitted lib/, the shipped
#    defaults, the refusals, the reason codes and the supervisor entry point.
npm run build
npm run verify:artifacts

# 4. The full suite: build, then every *.test.js, including the CLI exit codes and a
#    spawnSync check that each PowerShell script parses and advertises -WhatIf.
npm test

# 5. The ticket, if a restart is pending. A ticket that does not verify is deleted by the
#    supervisor, so its presence is normal and its absence is not necessarily a fault.
if (Test-Path "$env:DSH_HOME\restart\ticket.json") { Get-Content "$env:DSH_HOME\restart\ticket.json" }

# 6. The last few supervisor events, newest last.
Get-Content "$env:DSH_HOME\restart\supervisor.log" -Tail 10
```

What a healthy installation looks like: `restart_status` reports `can_restart: true` with reason `OK`, `supervisor.present: true` with an `ageMs` well under the timeout, `crash_loop.tripped: false`, and `capabilities.checkpointPort: true`. A healthy *degraded* installation reports `capabilities.checkpointPort: false` and still runs DS-Hns perfectly — it simply cannot authorize a restart, which is the failure mode this plugin is designed to have.
