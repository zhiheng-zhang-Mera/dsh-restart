# Security policy

## Reporting a vulnerability

Report security issues privately, **not** in the public issue tracker:

- open a [private security advisory](https://github.com/dsh-restart/dsh-restart/security/advisories/new)
  on the repository, or
- email the maintainers at the address listed in the repository profile.

Please include: the affected version, the platform, a description of the impact, the
smallest reproduction you have, and whether the issue is already public. If you are unsure
whether something is a vulnerability, report it anyway — a wrong guess costs nothing.

**What to expect.** Acknowledgement within 7 days. An assessment (accepted, needs more
information, or out of scope) within 14 days, with the reasoning. For an accepted issue, a
fix or a documented mitigation, and credit in the release notes unless you ask otherwise.
Please give us 90 days before public disclosure, or less if a fix ships sooner.

**In scope:** anything that lets a non-privileged actor cause a restart, reboot, shutdown
or arbitrary command execution; anything that defeats the restart lock, the cooldown, the
duplicate suppression or the checkpoint gate; anything that lets a forged or modified
ticket or ledger be acted upon; privilege escalation through the helper scripts; and
crashes in the harness triggered by plugin input.

**Out of scope:** an actor who already has write access to the state directory or to the
DSH profile (see the threat model — that actor is the trust boundary, not a bug);
denial of service by an actor who can already stop processes on the machine; the "Not
implemented yet" gaps listed in the README (reporting those is welcome, but they are known
and documented, not undisclosed).

## Threat model

### What this component is

`dsh-restart` is a DSH plugin with two parts: an in-process engine that decides whether a
restart may be executed safely, and an external supervisor process that observes the
harness exit and relaunches it. It has no network access, no data collection and no
telemetry.

### Assets

| Asset | Why it matters |
| --- | --- |
| The availability of DS-Hns | the design's promise is that the worst case is "automatic restart unavailable", never "DS-Hns unavailable" |
| The state directory (`<DSH_HOME>/restart` by default) | holds the ticket, heartbeat, ledger, supervisor log and audit log |
| Task state | **not accessed by this plugin at all** — it is listed here to state that explicitly |
| The machine's uptime | the system-reboot path, when it exists, ends every other program on the machine |

### Trust boundary

The plugin and the supervisor do not trust each other. What crosses between them is a
document on disk, verified independently by the reader:

| Threat | Mitigation | Residual risk |
| --- | --- | --- |
| A truncated or partially written ticket (power loss, hard kill) | atomic writes: temp file → `fsync` → `rename`; the reader never sees a mixture | none known |
| A modified ticket | `sha256` over the canonical JSON of every field except `checksum`; a mismatch deletes the ticket and logs `discarded_unverifiable_ticket` | **integrity, not authentication**: there is no shared secret, so an actor who can write the file can forge a ticket that verifies |
| A stale ticket acted on late | `expiresAt` is re-checked on every supervisor tick against the supervisor's own clock; an expired ticket is deleted | a very long `supervisor.ticketTtlMs` widens the window; the default is 10 minutes |
| A ticket for a different process | the ticket names a `pid`, and `verifyTicket` supports an expected pid; the supervisor adopts the ticket's pid deliberately, because the ticket is the fresher statement of intent | adoption is by design, not a defence |
| A stale heartbeat read as presence | presence is the age of the last beat: `heartbeatAgeMs()` prefers the `timestamp` the supervisor wrote and falls back to the file's `mtime` only when that timestamp is missing or unparseable, so a dead supervisor reads as absent within `heartbeatTimeoutMs` even if its file is touched | a process that can both write the state directory *and* forge a fresh `timestamp` can fake presence; that is the same write-access boundary as a forged ticket |
| A forged ledger that clears safe mode | the ledger is read by the supervisor to restore a tripped breaker; a forged ledger with `safeMode: false` re-arms automation | again: write access to the state directory is the boundary |
| A stuck restart blocking all future ones | the lock refuses illegal transitions and every working state can be released; `abort()` releases it on every failure path | see the `TICKET_WRITE_FAILED` note below |

### Privileged operations, precisely

| Operation | Where | Reachable when |
| --- | --- | --- |
| Request a graceful host shutdown | `HostShutdownPort` → `HostLifecycle.requestShutdown` | every accepted restart; the host can refuse |
| Launch a process (relaunch) | `ChildProcessLauncher.launch` (`node:child_process.spawn`) | the supervisor, after observing an exit |
| Read the process list | `SystemLivenessProbe` (`tasklist.exe`, `ps`) | every supervisor tick |
| Reboot the operating system | `WindowsSystemShutdownPort.requestSystemRestart` (`shutdown.exe /r /t <delay> /d p:4:1 /c <reason>`) | **never in this release**: the port is implemented and exported, but the pipeline never calls it. If that changes, the gates are `allowSystemReboot` **and** `systemRestart.enabled` **and** the request's own `acknowledgeSystemReboot`, all defaulting to off |
| Stop the supervisor | `scripts/uninstall.ps1` (`Stop-Process`, **supervisor only**) | operator action; the pid is taken from `heartbeat.json` and the process's command line must name `supervisor.mjs`, otherwise the script refuses unless `-Force` is given |

**No shell is ever used.** Every external command goes through `execFile` with an argument
array — `runProcess` for `shutdown.exe`, `runCapture` for `tasklist.exe`/`ps`, `spawn` for
the relaunch. There is no `exec`, no `shell: true` and no string interpolation into a
command line, so a `reasonSummary`, a `reasonCode` or a ticket field cannot become part of
a command. The reboot reason is additionally truncated to 200 characters before being
passed as an argument.

**No network access.** The plugin opens no sockets, resolves no names and makes no
outbound connections. If you observe network activity attributed to it, that is a security
issue worth reporting.

**No `process.exit`, no pid signalling as a normal path.** The engine never ends the host's
process and never signals a pid. A plugin that could kill its host could make DS-Hns
unavailable, which the design forbids; the only thing it can do is *ask*, through a port.

### Configuration as a security surface

| Setting | Risk if changed carelessly |
| --- | --- |
| `allowedSources` | grants the ability to end the process to another module. The list cannot be emptied (`ConfigError`), and adding a source is an authorization decision |
| `allowSystemReboot` + `systemRestart.enabled` + `acknowledgeSystemReboot` | three independent gates on rebooting the machine; all default to off |
| `safety.checkpointRequired` | setting it to `false` allows a restart without any confirmation that the harness reached a safe point. This is the one setting that can lose work, and the design forbids it as a default |
| `safety.allowRestartWithoutSupervisor` | turns a restart into a probable outage: the process exits and nothing brings it back |
| `safety.allowForceTerminate` | declared but never consulted in this release; a future implementation of force-termination would make an accepted shutdown able to kill a process that may still be writing |
| `safety.duplicateSuppression` | turning it off removes one of the three defences against a request storm |
| `supervisor.launchCommand` | an arbitrary executable that the supervisor will run. It is operator-supplied configuration, and it is executed with the supervisor's privileges |
| `storage.directory` | where the audit trail lives; a world-writable location lets another actor forge tickets and ledgers |

### Deployment guidance

- Restrict the state directory to the account that runs DS-Hns. That directory is the trust
  anchor for tickets, heartbeats and the ledger: anything that can write it can forge all
  three.
- Keep the audit log. It is append-only, bounded and rotated, and it is the only record of
  why a restart happened.
- Treat a git install as code execution: `dsh plugin add` of a git dependency runs this
  package's `prepare` script unless the package manager is configured not to. Prefer npm or
  a tarball, or install from a checkout you have reviewed and built yourself.
- The helper scripts are not sandboxed. Run them with the same care as any other
  administrative PowerShell script, and use `-WhatIf` first.
- Do not set `safety.allowRestartWithoutSupervisor: true` on a machine whose availability
  matters.

### Known security-relevant limitations

- The ticket checksum is **integrity, not authentication** (no shared secret exists that
  both processes could hold safely).
- `abort()` clears the ticket before releasing the lock. If the ticket can neither be
  written nor deleted — for example a state directory that is unwritable *and* contains an
  undeletable `ticket.json` — the exception escapes `handle()` instead of returning a
  structured refusal. This is a robustness gap on an already-broken deployment, not a way
  to force a restart.
- Safe mode is enforced by the supervisor reading `ledger.json`. The plugin does not read
  that file, so a running plugin's `CRASH_LOOP` refusal depends on `tripCrashLoop()` having
  been called, which nothing inside this package does.

## Supported versions

Security fixes are applied to the latest released minor version. As this is a `0.x`
project, the API, the configuration surface and the wire protocol may still change between
minor versions; a breaking protocol change is announced by bumping `PROTOCOL_VERSION`, and
a breaking ticket change by bumping `TICKET_SCHEMA_VERSION` (see
[docs/protocol.md](docs/protocol.md#versioning-rules)).
