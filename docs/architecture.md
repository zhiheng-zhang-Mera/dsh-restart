# Architecture

`dsh-restart` is two processes and one file. The plugin lives inside DS-Hns and decides
whether a restart may be executed safely; the supervisor lives outside DS-Hns and is the
only thing that can bring it back. They never call each other, never share memory, and
never hold a socket: everything that crosses the boundary is a document on disk that one
side writes and the other verifies.

That shape is not an implementation detail. It is what lets the plugin die without taking
the host with it, and what lets a restart survive the process that requested it.

---

## 1. The two-process picture

```
┌─────────────────────────────────────────── DS-Hns process ──┐
│                                                              │
│  requester ──► RestartManager                                │
│  (health-scheduler, dsh-cli, operator)                       │
│                     │                                        │
│    validateShape ───┤                                        │
│    validateRequest ─┤                                        │
│    RestartLock ─────┤   the whole pipeline is in-process:     │
│    CheckpointGate ──┤   no timers that exit the host,         │
│    TicketStore ─────┤   no signals, no process kills,         │
│    RestartAuditLog ─┤   no direct access to task state        │
│                     │                                        │
│  ShutdownPort ◄─────┘   "please exit", through a port only    │
│        │                                                     │
│        └─► the host owns its own lifecycle and exits          │
└──────────────────────────────────────────────────────────────┘
                     │
        writes  <state>/ticket.json   (atomic, checksummed)
        writes  <state>/restart-attempts.jsonl
                     │
        reads   <state>/heartbeat.json
                     │
┌──────────────────────────────────── external supervisor ─────┐
│                                                              │
│  RestartSupervisor                                           │
│    SystemLivenessProbe ── pid alive? (signal 0, tasklist, ps) │
│    CrashLoopBreaker ───── rolling unclean-start window        │
│    ChildProcessLauncher ─ spawn the relaunch command          │
│    HeartbeatWriter ────── writes heartbeat.json               │
│                                                              │
│  writes <state>/heartbeat.json, <state>/ledger.json,          │
│         <state>/supervisor.log                                │
│  reads  <state>/ticket.json  (and deletes it when consumed)   │
│  never: task queue, task state, worker scheduling, health     │
└──────────────────────────────────────────────────────────────┘
```

The supervisor is deliberately the smallest thing that can own a process lifecycle: watch
a pid, read a ticket, wait for the exit, relaunch, verify liveness, give up loudly if that
keeps failing. It has no idea what DS-Hns does.

### Why the plugin cannot restart anything by itself

`RestartManager` never calls `process.exit`, never signals a pid and never spawns a
replacement. Its last act on a successful path is `shutdown.requestShutdown(ticketId)` —
a request, through an injected port, that the *host* is free to refuse. If the host
refuses, the ticket is deleted, the lock is released and the caller gets
`SHUTDOWN_PORT_UNAVAILABLE`.

This is why the plugin's worst case is bounded. A plugin that cannot kill its host cannot
make the host unavailable; the most it can do is decline to restart it.

---

## 2. The trust boundary

The supervisor is a different process and must not trust the plugin. The ticket is
therefore a self-describing, versioned, checksummed document, and the supervisor treats
anything that does not verify as a hazard rather than a hint.

| Question | Who answers it | How |
| --- | --- | --- |
| May this restart happen? | the plugin | validation, lock, cooldown, checkpoint gate |
| Did the plugin authorise it? | the supervisor, independently | it re-reads and re-verifies `ticket.json`; it never trusts the plugin's memory |
| Is the ticket genuine? | the supervisor | `schemaVersion` equality, then `sha256` of the canonical JSON |
| Is the ticket still valid? | the supervisor | `expiresAt` against its own clock |
| Is the harness alive? | the supervisor | its own liveness probe; it asks nobody |
| Did the relaunch work? | the supervisor | liveness of the relaunched pid after `relaunchTimeoutMs` |
| Is the plugin alive? | the supervisor does not care | the plugin's death changes nothing about relaunching |
| Is the supervisor alive? | the plugin | the age of `heartbeat.json` on disk |

Three properties follow, and each is intentional:

1. **The checksum is integrity, not authentication.** There is no shared secret, because
   there is nowhere safe to keep one that both processes can read. The digest detects a
   truncated or edited ticket; it does not prove authorship. Anything that can write the
   state directory can forge a ticket that verifies, which is why the state directory's
   filesystem permissions are part of the security model (see
   [SECURITY.md](../SECURITY.md)).
2. **A doubtful ticket is destroyed, not repaired.** `verifyTicket` returns a rejection
   and `TicketStore.consume`-style callers delete the file. The supervisor's tick clears
   an unverifiable ticket and logs `discarded_unverifiable_ticket`, then keeps monitoring.
   Leaving it in place is the failure this design exists to prevent.
3. **The plugin's absence is survivable.** The supervisor never waits for the plugin. If
   the plugin dies mid-flight, the ticket is already on disk and the supervisor acts on
   the document, not on the process.

### What crosses, in which direction, and when

| Artifact | Direction | Written when | Consumed when |
| --- | --- | --- | --- |
| `ticket.json` | plugin → supervisor | after the checkpoint gate passes, before the shutdown request | on every supervisor tick; deleted once the exit is observed or the ticket is void |
| `heartbeat.json` | supervisor → plugin | every `heartbeatIntervalMs`, and immediately on every state change | on every status read and every request validation |
| `ledger.json` | supervisor → supervisor (and operators) | on relaunch, on unclean starts, on entering safe mode | at supervisor startup, to restore a tripped breaker |
| `supervisor.log` | supervisor → operators | one line per event, also mirrored to stderr | by a human or a log collector |
| `restart-attempts.jsonl` | plugin → operators | on every accepted, refused, aborted or cancelled attempt | by a human or a log collector; rotated at `storage.maxLogBytes` |

---

## 3. The lock state machine

Exactly one restart may be in flight. `RestartLock` owns that invariant with **declared**
edges, so a bug elsewhere cannot walk the lock into a state with no way out — an illegal
transition is refused and reported, which is how a stuck restart becomes visible instead
of silently blocking every future one.

```
IDLE ──► REQUESTED ──► CHECKPOINTING ──► SHUTTING_DOWN ──► RELAUNCHING ──► VERIFYING
  ▲           │               │                 │                │              │
  │           │               │                 │                │              │
  └───────────┴───────────────┴─────────────────┴────────────────┴──────────────┘
                              (every working state may be abandoned)
```

The declared edges, verbatim from `restart-lock.ts`:

| From | Allowed to |
| --- | --- |
| `IDLE` | `REQUESTED` |
| `REQUESTED` | `CHECKPOINTING`, `SHUTTING_DOWN`, `IDLE` |
| `CHECKPOINTING` | `SHUTTING_DOWN`, `IDLE` |
| `SHUTTING_DOWN` | `RELAUNCHING`, `IDLE` |
| `RELAUNCHING` | `VERIFYING`, `IDLE` |
| `VERIFYING` | `IDLE` |

Notes that matter in practice:

- **`IDLE → REQUESTED` requires a request id.** The refusal is
  `entering REQUESTED requires a request id`, and it is what stops an anonymous restart.
- **Any working state may reach `IDLE`.** A refused checkpoint, a failed shutdown, an
  explicit cancel and a startup reconciliation all release the lock, so no single failure
  can wedge the machine into "restarts are permanently refused".
- **`REQUESTED → SHUTTING_DOWN` exists** for the path where a request needs no checkpoint.
- **`release(reason)` is not a transition.** It is the deliberate escape hatch used by
  `abort()`, and it returns the state it left so the reason is not lost.
- **In this release the lock stops at `SHUTTING_DOWN` on the success path**, because the
  process is expected to exit. `RELAUNCHING` and `VERIFYING` are reachable through the
  declared edges and are exercised by the lock's own tests, but the manager does not drive
  them: after `accepted: true` the supervisor owns the rest, in another process. This is
  why `restart_status` can legitimately report `lock: "SHUTTING_DOWN"` for the remaining
  life of a process that is on its way out.

Each lock state maps onto a request state for reporting: `IDLE → completed`,
`REQUESTED → queued`, `CHECKPOINTING → checkpointing`, `SHUTTING_DOWN → shutting_down`,
`RELAUNCHING → relaunching`, `VERIFYING → verifying`.

---

## 4. The supervisor state machine

```
MONITORING ──(a valid ticket exists)──► WAITING_FOR_EXIT
     │                                        │
     │ (process died, no ticket)              │ (the watched pid is gone)
     │                                        ▼
     │                                   RELAUNCHING ◄──────────┐
     │                                        │                 │
     │                                        ▼                 │ (retry while the
     │                              WAITING_FOR_HEARTBEAT ───────┘  breaker allows)
     │                                        │
     │                                        │ (the relaunched pid is alive)
     │                                        ▼
     │                                     VERIFIED ──► MONITORING
     │
     └──(crash-loop limit reached)──► CRASH_LOOP ──► SAFE_MODE
```

| State | Meaning | Leaves when |
| --- | --- | --- |
| `MONITORING` | watching; no ticket in play | a valid ticket appears (→ `WAITING_FOR_EXIT`), the process dies (→ breaker, then `RELAUNCHING`), or the breaker is tripped (→ `SAFE_MODE`) |
| `WAITING_FOR_EXIT` | a valid ticket was accepted; waiting for the watched pid to go away | the pid is gone (→ `RELAUNCHING`); a probe that cannot answer keeps it here and logs `liveness_probe_failed` |
| `RELAUNCHING` | deriving a launch spec and spawning | spawn succeeds (→ `WAITING_FOR_HEARTBEAT`), spawn fails (counted against the breaker), no spec derivable (→ `SAFE_MODE`, `NO_LAUNCH_COMMAND`) |
| `WAITING_FOR_HEARTBEAT` | the relaunched pid has to be alive within `relaunchTimeoutMs` | it is alive (→ `VERIFIED`), or it is not (unclean start, then retry or `CRASH_LOOP`) |
| `VERIFIED` | the relaunch was observed alive | immediately → `MONITORING` (the state exists so the event stream can show it) |
| `CRASH_LOOP` | the breaker tripped | → `SAFE_MODE` when `safeModeOnLoop` is true; the run ends either way |
| `SAFE_MODE` | automation is off; a human is required | only by clearing the ledger. The supervisor never decides that enough time has passed |
| `STOPPED` | declared in the `SupervisorState` union | **never assigned by any code path** — see "Not implemented yet" |

Two details worth stating precisely, because the names mislead:

- **`WAITING_FOR_HEARTBEAT` does not wait for a heartbeat from DS-Hns.** There is no
  application heartbeat in this design. The supervisor verifies the relaunch with its own
  liveness probe against the pid it spawned, and the only heartbeat file is the
  supervisor's own, written for the *plugin* to read. The design document lists "read the
  heartbeat" as a supervisor responsibility; the implementation inverts that direction.
- **`SAFE_MODE` stops relaunching; it does not start a degraded DS-Hns.** In the paths
  that reach it after a death (crash during monitoring, or no liveness after a relaunch)
  the harness is down and stays down until a human starts it. The log line
  `"automation is disabled; DS-Hns still runs"` is accurate only for the case where
  DS-Hns is up and the *plugin* is what failed.

Events are emitted for every state change with a machine-readable `code` and written to
`supervisor.log` as one JSON object per line — for example `supervisor_boot`,
`restart_ticket_accepted`, `discarded_unverifiable_ticket`, `process_died_without_ticket`,
`relaunching`, `relaunched`, `relaunch_verification_failed`, `crash_loop_limit_reached`,
`safe_mode_entered`, `safe_mode_manual_action_required`, `supervisor_stopped`.

---

## 5. The ticket lifecycle

```
        (no ticket)
             │
             │  RestartManager.handle(): checkpoint gate passed
             ▼
   ┌──────────────────────────┐
   │ ticket.json written      │  writeFileAtomic: temp file → fsync → rename
   │ schemaVersion 1          │  checksum = sha256(canonicalJson(all but checksum)
   │ expiresAt = now + ttl    │
   └──────────────────────────┘
             │
             ├── host refuses the shutdown ──► clearTicket() ──► audit: failed
             │
             ▼
   ┌──────────────────────────┐
   │ handed to the supervisor │  the plugin does not wait; the process exits
   └──────────────────────────┘
             │
             ├── supervisor tick: does not verify ──► clearTicket() + discarded_unverifiable_ticket
             ├── supervisor tick: expired / wrong schema ──► same
             ├── supervisor tick: names another pid ──► adopts that pid, keeps the ticket
             ▼
   ┌──────────────────────────┐
   │ exit observed            │  clearTicket() before relaunching
   └──────────────────────────┘
             │
             ▼
   ┌──────────────────────────┐
   │ relaunch → verify        │  ledger.json records relaunches / unclean starts
   └──────────────────────────┘

   (a new process at startup)
             │
             └── reconcileAfterRestart(): any ticket still present is from a process
                 that did not exit. It is deleted and reported; the next supervisor
                 tick therefore finds nothing and the stale intent cannot be acted on.
```

Every step is idempotent or self-clearing: a ticket is either consumed, voided, or
reconciled away by the next process. There is no state in which an old ticket can cause a
restart nobody asked for, because the supervisor re-verifies expiry on every tick and the
plugin deletes whatever it finds at startup.

---

## 6. Where each responsibility stops

The interesting part of this design is not what each component does; it is where each one
refuses to go further.

| Component | Stops at | Because |
| --- | --- | --- |
| `dsh-restart` plugin | writing the ticket and asking the host to exit | the host owns its own lifecycle; the plugin has no privileged way to end it |
| `dsh-restart` plugin | the checkpoint *answer* | it never saves task state; a missing or unsafe answer aborts the restart rather than being worked around |
| `dsh-restart` plugin | `DISABLED`/`CRASH_LOOP` refusals | it has no notion of *why* a restart is wanted, so it cannot override its own bounds on a hunch |
| supervisor | watching, relaunching, counting failures | it must not become a second DS-Hns: no task queue, no worker scheduling, no health, no temperature |
| supervisor | entering safe mode | it will not re-arm automation on its own after "enough time"; that is an operator decision |
| DS-Hns Core | supplying the checkpoint and consuming the resume | only the harness knows what a safe point is |
| DS-Hns Core | saving and restoring task state | the plugin has no access and wants none |
| `dsh-health-scheduler` | submitting a request | deciding and executing are separate processes on purpose |

## Not implemented yet

Divergences from the design document that belong in an architecture note, because they
change the shape of the system rather than a detail:

- **System reboot is not wired.** The `SystemShutdownPort` chain exists and is exported,
  but `RestartManager` reads it only to report `capabilities.systemRestart`. No path calls
  `requestSystemRestart`, so `mode: "system"` currently ends in a host shutdown request
  plus a `mode: "system"` ticket — not a reboot. The supervisor ignores `ticket.mode`
  beyond logging it, so that ticket relaunches the application exactly like any other.
- **Nothing drives the lock past `SHUTTING_DOWN`.** `RELAUNCHING` and `VERIFYING` are
  declared, testable and unreached in production, because the supervisor is a separate
  process that keeps no lock.
- **The plugin never observes the outcome of the restart it requested.** After
  `accepted: true` it is expected to be gone. Reconciliation at the next startup is the
  only feedback, and it reports "the previous process did not exit" rather than "the
  restart succeeded".
- **`SupervisorState.STOPPED` is never assigned.** A stopped supervisor is an absent one,
  detected by heartbeat age.
- **`spawnSupervisor()` is never called**, so the two-process picture must be assembled by
  an operator or a wrapper script rather than by the plugin.
- **The plugin does not read `ledger.json`.** Safe mode is enforced by the supervisor
  alone; the plugin's own `CRASH_LOOP` refusal is driven by `tripCrashLoop()`, which
  nothing inside this package calls.
