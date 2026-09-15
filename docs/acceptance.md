# Acceptance

This document maps every acceptance criterion in the design document
(`plugin-dsh-restart-plan.md`, sections 14 and 15) to something that can actually be run.
It distinguishes three kinds of evidence:

- **automated** — a named test in `tests/*.test.js`, run by `npm test`
- **manual** — a reproducible command or inspection, with the expected result
- **Windows E2E pending** — genuinely requires a real machine, a real desktop session and
  a real DS-Hns profile; no amount of unit testing substitutes for it

Anything that is currently unverified is listed as unverified. Nothing here names a test
that does not exist.

## How to run the checks

```powershell
npm install
npm test                   # builds lib/ then runs node --test tests/*.test.js
npm run test:only          # the same tests without rebuilding
npm run typecheck          # tsc --noEmit
npm run verify:artifacts   # artifact checks against lib/ and bin/
node bin/supervisor.mjs --help
node --test --test-name-pattern "safe mode" tests/supervisor.test.js
```

The test suite is organised as six files: `validation.test.js` (request shape, request
policy, the lock, tickets), `manager.test.js` (the pipeline, checkpoint gate, duplicate
suppression, cooldowns, the system gate, cancellation, reconciliation, breaker
integration, supervisor presence, status, the audit log), `supervisor.test.js` (liveness
probes, breaker, launch derivation, the state machine, the run loop), `plugin.test.js`
(plugin exports, `applyRestart`, the model-facing tools, protocol conformance, and the
plugin/supervisor agreement on tickets), `integration.test.js` (the supervisor's own
command line and exit codes, the four PowerShell scripts parsed and inspected for
forbidden operations, and repository hygiene) and `cross-plugin.test.js` (the documented
bridge to `dsh-health-scheduler`, driven end to end through **both** real plugins —
it imports the sibling checkout, so it skips when that checkout is absent).
`tests/helpers/rig.js` and `tests/helpers/checkpoints.js` provide the injected seams
every test drives the real classes through — the unit suites reboot nothing, kill
nothing and shell out to nothing; `integration.test.js` is the one file that starts a
process, and the process it starts is the supervisor with `--max-ticks 1`.

`cross-plugin.test.js` is the only file that reaches outside this repository, and it does
so deliberately: the seam between the two plugins is prose in a README, and prose that
nothing executes is prose that rots. It builds the four-line `RestartAdapter` the health
scheduler documents on top of this plugin's real `RestartManager`, then drives a real
`HealthScheduler` decision through it and asserts on the ticket that came out the other
side. It found one calibration fact worth recording: because a single measured dimension
renormalizes to `effectiveWeight: 1.0`, a saturated lone metric reads `restart_pressure:
100`, so the test pins a sub-saturating value and a matching ladder rather than letting
the top rung fire.

## Design section 15: the fifteen acceptance criteria

| # | Criterion (design §15) | Evidence | Status |
| --- | --- | --- | --- |
| 1 | Restart contains no health policy | `plugin.test.js` → `plugin exports` → *contains no health policy and no scheduling of any kind* | automated |
| 2 | Restart contains no time-scheduling algorithm | same test as #1 (it asserts the absence of scheduling constructs); `validation.test.js` → `request shape validation` → *rejects an unknown mode and a non-boolean checkpoint flag* covers the shape equivalent | automated |
| 3 | Health Scheduler can be uninstalled without affecting manual restart | manual: `allowedSources` includes `operator` and `dsh-cli` by default, and nothing in `src/` imports or requires `dsh-health-scheduler` (`grep -r "health-scheduler" src/` matches only configuration defaults and documentation strings) | manual |
| 4 | Restart can be uninstalled and DS-Hns still runs | manual: `scripts/uninstall.ps1` plus the design of `applyRestart`, which registers one settings namespace and three tools and nothing that gates boot; `plugin.test.js` → `applyRestart` → *runs without a tools service or a settings service*; `integration.test.js` → `PowerShell deployment scripts` → *never kills DS-Hns as a normal path*, *all four exist and declare their contract* | manual + automated |
| 5 | One restart request executes at most once | `manager.test.js` → `duplicate suppression` → *returns the original answer for a retried request id and restarts nothing twice*; *refuses the same id used for a different request*; `validation.test.js` → `request policy validation` → *refuses a duplicate request id* | automated |
| 6 | A failed checkpoint does not restart by default | `manager.test.js` → `checkpoint gate` → *aborts when the harness reports an unsafe safe point*, *aborts when the checkpoint starts but does not complete*, *aborts, rather than proceeding, when the checkpoint port throws*, *abandons a checkpoint that never answers instead of hanging the lock*, *refuses every request when no checkpoint port is bound and one is required*; `validation.test.js` → *refuses when a required checkpoint cannot be verified* | automated |
| 7 | A dead supervisor does not drag DS-Hns down | `manager.test.js` → `supervisor presence` → *refuses when no heartbeat has been seen, because exiting is not restarting*; `supervisor.test.js` → `supervisor state machine` → *never acts on a liveness probe that could not answer*; `integration.test.js` → `supervisor command line` → *reports safe mode as a distinct exit code, so a wrapper can tell* | automated |
| 8 | A dead restart plugin does not drag DS-Hns down | `plugin.test.js` → `applyRestart` → *reports a rejected configuration and keeps running on the defaults*; *runs without a tools service or a settings service* | automated |
| 9 | Crash loop trips automatically | `supervisor.test.js` → `crash-loop breaker` → *allows relaunches until the limit, then trips*; *uses a rolling window, so old crashes stop counting*; *restores a tripped state from the ledger, so a restart cannot clear it*; `supervisor state machine` → *enters safe mode after the crash-loop limit instead of looping forever* | automated |
| 10 | Safe mode can start | `supervisor.test.js` → `supervisor state machine` → *enters safe mode after the crash-loop limit instead of looping forever*; *stays in safe mode once tripped, even if a ticket arrives*; manual: `node bin/supervisor.mjs --state <dir-with-safeMode-ledger>` exits **3** (verified) | automated + manual |
| 11 | Tasks can resume after an application restart | **unverified by this repository.** Resumption is DS-Hns Core's job; this plugin only asks for a checkpoint and never touches task state. No test here can prove resumption. | Windows E2E pending |
| 12 | Tasks can resume after a system reboot | **partly automated / partly E2E:** the reboot port is called and its refusals are tested; resuming tasks after a reboot needs a real machine and a real profile (see [What needs a real Windows E2E run](#what-needs-a-real-windows-e2e-run)) | E2E pending |
| 13 | No restart storm exists | `manager.test.js` → `cooldowns` → *enforces the minimum interval after an accepted restart*; *reports the remaining cooldown in the status payload*; `duplicate suppression` (as #5); `application restart pipeline` → *accepts a valid request, writes a ticket, and asks the host to shut down* (the lock is held thereafter) | automated, with the caveat below |
| 14 | Every anomaly has a structured log | `manager.test.js` → `audit log` → *writes accepted, refused and cancelled attempts to disk with schema versions*, *never throws when the audit directory cannot be written*; `supervisor.test.js` → `supervisor run loop` → *logs every state change with a machine-readable code*, *contains a throwing log observer*; `integration.test.js` → `supervisor command line` → *runs a bounded number of ticks and exits cleanly* (asserts `supervisor_boot`/`supervisor_stopped` on stderr and that `heartbeat.json` and `supervisor.log` were written) | automated |
| 15 | Real E2E on the latest Windows environment | see [What needs a real Windows E2E run](#what-needs-a-real-windows-e2e-run) | Windows E2E pending |

Criteria #11, #12 and #15 are the honest gaps. #12 is not merely untested but
unimplemented, and #11 cannot be evidenced from this repository at all.

## Design section 14: unit and integration coverage

| Design §14 item | Test |
| --- | --- |
| request validation | `validation.test.js` → `request shape validation` (8 tests), `request policy validation` (15 tests) |
| restart lock | `validation.test.js` → `RestartLock` (9 tests) |
| cooldown | `manager.test.js` → `cooldowns` (3 tests); `validation.test.js` → *refuses inside a cooldown and reports the remaining time* |
| dedupe | `manager.test.js` → `duplicate suppression` (3 tests) |
| ticket persistence | `validation.test.js` → `tickets` (13 tests), including checksum tampering, expiry, schema version, wrong pid and atomic write |
| crash-loop breaker | `supervisor.test.js` → `crash-loop breaker` (6 tests) |
| state transitions | `validation.test.js` → `RestartLock`; `supervisor.test.js` → `supervisor state machine` (11 tests) |
| fake DS-Hns → graceful exit → relaunch | `supervisor.test.js` → `supervisor state machine` → *honours a ticket: waits for the exit, relaunches, and verifies*; `plugin.test.js` → `supervisor and plugin agree on the ticket` → *writes a ticket the supervisor accepts, consumes and erases* |
| checkpoint success | `manager.test.js` → `application restart pipeline` → *runs the checkpoint gate before writing anything*; `checkpoint gate` → *proceeds without a checkpoint only when the request does not require one* |
| checkpoint failure | `manager.test.js` → `checkpoint gate` (5 abort/refusal tests) |
| duplicate request | `manager.test.js` → `duplicate suppression` (3 tests) |
| supervisor unavailable | `manager.test.js` → `supervisor presence` (3 tests) |
| relaunch failure | `supervisor.test.js` → `supervisor state machine` → *counts a failed launch against the breaker rather than retrying blindly*, *gives up cleanly when no launch command can be derived*, *gives up on a relaunch that never comes back alive* |
| safe-mode fallback | `supervisor.test.js` → `crash-loop breaker` → *restores a tripped state from the ledger, so a restart cannot clear it*; `supervisor state machine` → *stays in safe mode once tripped, even if a ticket arrives* |

Beyond the design's own list, `integration.test.js` covers the deployment surface that
unit suites cannot reach: `supervisor command line` (--help exits 0 and prints usage, an
unknown option is rejected rather than guessed, a bounded run exits cleanly and writes its
heartbeat and log, and safe mode is a distinct exit code), `PowerShell deployment scripts`
(all four exist with comment-based help and `-WhatIf`, parse under the Windows PowerShell
parser, expose `-Profile`, and are inspected so that none can grow a `taskkill`, a
`shutdown /r` or a path that stops DS-Hns), and `repository hygiene` (no runtime artifacts
tracked, the bundle patch and supervisor binary declared in `package.json`, no `.ts`
specifier in the built entry points, and no dependency on the health plugin).

## Criteria that are only partly evidenced

These deserve to be called out rather than hidden behind a green suite.

| Criterion | What the tests actually prove | What they do not |
| --- | --- | --- |
| #13 "no restart storm" | that a second request is refused — but *enforces the minimum interval after an accepted restart* accepts **either** `COOLDOWN_ACTIVE` **or** `RESTART_IN_FLIGHT` as the reason | that the cooldown specifically is what stopped it. After an accepted restart the lock is still `SHUTTING_DOWN`, so through the public API the second request is normally refused earlier, by the lock. `COOLDOWN_ACTIVE` is proven at the validator level (*refuses inside a cooldown and reports the remaining time*) and stays reachable for the next process only if that process had a cooldown to begin with — and cooldown state is in-memory, so a fresh process starts with `remainingMs: 0`. The cross-restart bound is therefore **not** enforced; see [Not implemented yet](#not-implemented-yet). |
| #2 "no time scheduling" | that the plugin has no scheduling code | nothing about the requester. A health scheduler that schedules restarts is a different repository, by design. |
| #7 "supervisor death" | the plugin's refusal behaviour when no heartbeat is present | that an operator notices: that is heartbeat monitoring plus the exit-code-3 contract, documented in [operations.md](operations.md#recovering-from-safe-mode). |
| #14 "structured logs" | that the audit log and supervisor log entries are structured and tolerant | that *every* anomaly is logged. Refusals, aborts, cancellations and accepted attempts are recorded; a process that dies without exiting leaves only the ticket that the next startup reconciliation reports. |
| #8 "plugin death" | the plugin's tolerance of missing services and bad configuration | that a plugin crashing *mid-restart* leaves the system consistent. The mechanism is the ticket on disk plus `reconcileAfterRestart()`, tested by `manager.test.js` → `startup reconciliation` (3 tests), but the crash itself is not simulated end to end. |

## What needs a real Windows E2E run

The design's §14 Windows E2E matrix cannot be satisfied from this repository. Each item
below needs a real machine, a real desktop session and a real profile, and each is listed
with what the run must actually demonstrate:

| Scenario | What the run must show | Why automation cannot settle it |
| --- | --- | --- |
| Normal application restart | ticket → exit → relaunch → `relaunch_verified` in `supervisor.log`, and DS-Hns serving again | needs the real host lifecycle behind `ShutdownPort`; `HostShutdownPort` is wired to a `RecordingLifecycle` unless the host injects its own |
| Restart while idle | the checkpoint port answers safe and the restart proceeds | needs a real harness answering `prepareForRestart` |
| Restart during a worker task | the harness either completes a checkpoint or answers unsafe, and an unsafe answer **aborts** | needs a real task in flight |
| Restart during a Computer Use task | same, with a longer/real safe-point wait | needs the real Computer Use environment |
| Restart request during a git operation | refusal or deferral with a real reason such as `git_commit_in_progress`; no half-committed state | needs a real repository and a real commit in progress |
| Shutdown timeout | what actually happens when the host accepts the shutdown and then does not exit | **automatable by inspection**: `WAITING_FOR_EXIT` is bounded by `safety.shutdownTimeoutMs`, after which the restart is abandoned and recorded — or the process is terminated when `allowForceTerminate` is on and a terminator is bound. Both paths have named tests; what still needs a real machine is the timing of a genuinely hung DS-Hns — see [failure-modes.md](failure-modes.md#case-4--graceful-shutdown-hangs) |
| Restart after profile corruption | the plugin logs a rejected configuration, continues on defaults, and DS-Hns still boots | needs a genuinely corrupted profile plus a harness boot |
| System reboot | a reboot, and the machine coming back | **cannot be automated**: the reboot port is called by the pipeline, but a real reboot needs a real machine |
| Login / relaunch | DS-Hns relaunching after a session login | needs the real desktop/session integration (Task Scheduler or equivalent) |
| Task resume | task state surviving both restart kinds | DS-Hns Core's responsibility, provable only on a real install |

For all of these, the run must record: the exact `dsh --profile <p> --dump-config`
output, the `supervisor.log` and `restart-attempts.jsonl` from the run, the resulting
`ticket.json`/`heartbeat.json`/`ledger.json`, and the supervisor's exit code. A run that
cannot produce those artifacts has not demonstrated anything.

## Manual checks worth running before a release

```powershell
# 1. The artifacts are a usable build.
npm run build; npm run verify:artifacts

# 2. The whole suite, from the current sources.
npm test

# 3. The supervisor really starts, really stays alive, and really stops.
$dir = Join-Path $env:TEMP ('dsh-restart-acceptance-' + [guid]::NewGuid().ToString('N'))
node bin/supervisor.mjs --state $dir --tick-ms 150 --max-ticks 3   # -> exit 0
Get-Content (Join-Path $dir 'supervisor.log')                      # supervisor_started .. supervisor_stopped

# 4. Safe mode is exit code 3, not 0.
$ledger = '{"schemaVersion":1,"uncleanStarts":[],"safeMode":true,"safeModeReason":"process_died_without_ticket","safeModeAt":"2026-06-01T09:00:00.000Z","relaunches":2}'
Set-Content -Path (Join-Path $dir 'ledger.json') -Value $ledger -NoNewline -Encoding utf8NoBOM
node bin/supervisor.mjs --state $dir                               # -> exit 3

# 5. A bad command line fails loudly rather than silently doing nothing.
node bin/supervisor.mjs --nope                                     # -> exit 1
node bin/supervisor.mjs --state (Join-Path $dir 'file/sub')         # -> exit 2
```

Two of these are regression checks for real defects found while writing this document:

- the supervisor's entry point used to compare `import.meta.url` against a hand-built
  `file://D:/...` string, which never matches on Windows, so `node bin/supervisor.mjs`
  printed nothing and exited 0. `npm run verify:artifacts` now asserts that `--help`
  prints usage, which fails if that regresses.
- the supervisor's own timers are `unref`'d by design, so a bare `run()` drained the event
  loop after the first tick and the process exited without supervising. The entry point
  now holds the loop open for the duration of the run. Step 3 above fails if that
  regresses: `supervisor_stopped` never appears and the exit code is not 0.

## Not implemented yet

Restated here because three of the fifteen acceptance criteria cannot be met without
them:

| Item | Design reference | State |
| --- | --- | --- |
| Real reboot, login and relaunch on a live machine | §5 Level B, §14 | the port is implemented, exported and called by the pipeline; the reboot itself needs a real machine and is covered by the E2E list above rather than by the suite |
| Launching DS-Hns without automation on safe mode | §6.3 | safe mode stops relaunching; it does not start a degraded DS-Hns |
| Cross-restart cooldown persistence | §6.2 "enforce the lower bound" | cooldowns are in-memory; a fresh process starts with none |
| The plugin starting the supervisor | §11 "register supervisor" | `spawnSupervisor()` is exported but never called |

Implemented since the first draft of this document, and now covered by named tests:

| Item | Test |
| --- | --- |
| System reboot is performed through the system-shutdown port | `manager.test.js` → `system restart gate` → *performs a real reboot through the system-shutdown port*, *refuses a system restart when the machine has no reboot port*, *refuses when the reboot port itself refuses*, *refuses when the reboot port throws* |
| Force-terminate after a shutdown timeout | `supervisor.test.js` → `a shutdown that never lands` → *terminates a hung process only when force termination is permitted, and records the restart as dirty* |
| A deadline on the wait for the host to exit | `supervisor.test.js` → `a shutdown that never lands` → *abandons the restart once the budget expires* |
| A "dirty restart" record | same test: a forced end writes an `uncleanStarts` entry |
| `acknowledgeResume` after a restart | `supervisor.test.js` → `resume acknowledgement`; `manager.test.js` → `resume acknowledgement` |
| Bounded backoff between relaunch retries | `supervisor.test.js` → `relaunch pacing` |
| The plugin reading the supervisor's safe-mode ledger | `manager.test.js` → `supervisor safe mode is bridged into the plugin` |

## Related

- [failure-modes.md](failure-modes.md) — what each failure looks like to an operator
- [operations.md](operations.md) — running, tuning and recovering
- [architecture.md](architecture.md) — the two processes and the trust boundary
- [protocol.md](protocol.md) — the wire protocol and the ticket document
