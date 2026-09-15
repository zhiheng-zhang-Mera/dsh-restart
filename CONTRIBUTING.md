# Contributing

Thanks for helping. This repository has an unusually small surface on purpose, and most of
the review effort goes into keeping it small. Read the rules before the workflow: a change
that breaks one of them will be rejected regardless of how well it is tested.

## The rules that must not be broken

These come from the design document's §16 ("禁止事项") and are enforced by review. Each has
a test or an inspection that will catch it.

1. **No health policy.** Nothing here may judge *whether* a restart is warranted: no
   temperature thresholds, no memory-pressure heuristics, no "the app has been up too
   long" rule, no degraded-UI detection. If you find yourself writing a comparison against
   a sensor reading, the change belongs in `dsh-health-scheduler`.
   *Covered by* `plugin.test.js` → `plugin exports` → *contains no health policy and no
   scheduling of any kind*.
2. **No time scheduling.** No cron expressions, no "restart at 04:00", no quiet hours, no
   maintenance windows. The plugin has exactly one clock, and it exists to enforce
   cooldowns and ticket expiry.
3. **No task-queue access.** Never read, write, reorder or inspect the task queue, task
   state or worker scheduling. This plugin asks the harness for a checkpoint and believes
   the answer; it does not participate in task recovery.
4. **No `taskkill`, `Stop-Process`, `shutdown`, `process.exit` or pid signalling as a
   normal path.** The plugin asks the host to exit through `ShutdownPort` and nothing else.
   The supervisor launches processes; it does not kill them. (`pid-watch.ts` runs
   `tasklist.exe` / `ps` to *read* the process list, which is not a kill; the PowerShell
   helper scripts stop only the supervisor, never DS-Hns.)
5. **Never restart without a passing checkpoint when one is required.** If
   `checkpointRequired` is true and the answer is missing, unsafe, incomplete, thrown or
   timed out, the restart is **aborted**, not downgraded. `UnboundCheckpointPort` must keep
   reporting `safe: false`, and no default implementation may report success.
6. **A plugin load failure must never prevent DS-Hns from starting.** `apply` must not
   throw for a configuration problem, a missing tool runtime, a missing settings service or
   a missing port. Report through the logger and continue on the defaults. This is the
   difference between "automatic restart unavailable" and "DS-Hns unavailable".
7. **No unbounded retry.** Every retry loop is bounded by the crash-loop breaker or by a
   configured limit.
8. **No new runtime dependency.** `dependencies` is empty and stays empty: the plugin runs
   inside the host and must not add a supply-chain surface to it. Dev dependencies are
   fine.

## Build and test loop

```powershell
npm install
npm run build              # tsc -p tsconfig.json  -> lib/
npm test                   # build first, then node --test tests/*.test.js
npm run test:only          # just the tests, against the existing lib/
npm run typecheck          # tsc --noEmit
npm run verify:artifacts   # the artifact contract checks
node --test --test-name-pattern "cooldown" tests/manager.test.js   # one area
```

`npm test` builds first on purpose: every test imports from `lib/`, so a test run always
exercises emitted JavaScript rather than the TypeScript sources. If you change `src/` and
run only `npm run test:only`, you are testing the previous build — and that is the most
common way to be confused by this repository.

`npm run verify:artifacts` is the packaging contract: `lib/index.js` exposes `apply`,
`name`, `inject`, `resolveConfig`, `RestartManager` and `RestartSupervisor`; no file under
`lib/` imports a `.ts` specifier; `lib/shared/protocol.d.ts` ships; the documented
`applicationRestart.minIntervalMs` default resolves; `heartbeatTimeoutMs <=
heartbeatIntervalMs` and an empty `allowedSources` are refused; every
`SELF_REASON_CODES` value is a usable string; and `node bin/supervisor.mjs --help` exits 0
*and prints usage*. That last check exists because the entry point once exited 0 in
silence on Windows.

## How the code is organised

| Path | Responsibility |
| --- | --- |
| `src/shared/protocol.ts` | the wire contract: versions, state unions, `RestartRequest`/`RestartResponse`/`RestartStatus`, the ticket, the heartbeat, the ledger, `canonicalJson`, `SELF_REASON_CODES` |
| `src/shared/types.ts` | the configuration surface and the port interfaces (`CheckpointPort`, `ShutdownPort`, `SystemShutdownPort`) |
| `src/shared/config.ts` | `DEFAULT_CONFIG`, `deepMerge`, `resolveConfig`, `tryResolveConfig`, `ConfigError` |
| `src/plugin/` | the in-process engine: validation, lock, checkpoint gate, ticket store, audit log, ports, `applyRestart` |
| `src/supervisor/` | the external process: state machine, liveness probe, relaunch, heartbeat, crash-loop breaker |
| `bin/supervisor.mjs` | the supervisor entry point and its command line |
| `lib/` | build output; never edit by hand |
| `tests/` | `node:test` suites plus the injected-seam helpers in `tests/helpers/` |

Principles worth preserving:

- **Everything external is a port.** The engine never touches the filesystem, a process or
  the host directly; `ports.ts` is the only module that does, and each capability is a
  small named class. This is what makes every path testable without a real machine.
- **Every write that another process will read is atomic and self-validating.** Temp file,
  `fsync`, `rename`, plus a schema version and (for the ticket) a checksum.
- **Refusals are values, not exceptions.** A refusal carries a machine-readable code and a
  human-readable `detail`; an exception is reserved for a genuine bug.
- **A failure to log is not a failure to act.** `RestartAuditLog` records a write failure
  and keeps going; the supervisor's log observer is wrapped so a throwing observer cannot
  break supervision.

## How to add a port

The three existing ports are `CheckpointPort`, `ShutdownPort` and `SystemShutdownPort`,
all declared in `src/shared/types.ts`. To add a fourth capability (say, "quiesce the
indexer before exiting"):

1. **Declare the interface in `src/shared/types.ts`.** Keep it to the minimum the engine
   needs — usually one method with a documented return value and a failure meaning. Add
   the stable `id` field every port has, so diagnostics can name it.
2. **Provide a refusing default.** Like `UnboundCheckpointPort`, the default must mean
   "cannot do this", never "assume it worked". If a capability is absent, the engine's
   behaviour must degrade to a refusal with a documented code, not to a silent skip.
3. **Call it from exactly one place in the engine** (`src/plugin/restart-manager.ts`),
   wrapped in the same `try`/`catch` discipline as the existing ports: a throw becomes a
   refusal with a code, the ticket is cleared, the lock is released and the attempt is
   recorded. Never let a port throw out of `handle()`.
4. **Bind the real implementation in `src/plugin/ports.ts`** and in `applyRestart`
   (`src/plugin/index.ts`), with an injection point in `ApplyOptions` so tests and
   deployments can override it. Default to the refusing implementation.
5. **Add the capability to `RestartStatus.capabilities`** so a degraded install is visible
   rather than surprising, and update `statusPayload()` if the name should appear on the
   wire.
6. **Add a refusal code to `src/shared/protocol.ts` → `SELF_REASON_CODES`**, with a message
   that tells the operator what to fix. If the code can also come from the pipeline rather
   than validation, document it in the README's refusal table and in
   `docs/protocol.md`.
7. **Test all four answers**: success, refusal, throw and hang (with a timeout), through
   the injected seam — the pattern is already in `tests/helpers/checkpoints.js` and
   `tests/manager.test.js`.
8. **Document it**: the configuration key (if any) goes into `src/shared/config.ts` →
   `DEFAULT_CONFIG`, into `cordis.patch.yml` with its risk, into the README's configuration
   table and into `docs/operations.md`. A capability nobody can configure is a capability
   nobody can deploy.
9. **If the capability crosses the process boundary**, it belongs in the ticket instead:
   add a field, bump `TICKET_SCHEMA_VERSION` only for a breaking change, and update
   `verifyTicket` and the supervisor together.

## Changing configuration

A new key requires: the interface in `src/shared/types.ts`, the default in
`DEFAULT_CONFIG`, a validator branch in `resolveConfig` that refuses anything unenforceable
(name the dotted path), a commented entry in `cordis.patch.yml` stating the effect and the
risk of changing it, and rows in the README and `docs/operations.md`. A value the plugin
cannot enforce must be rejected at load rather than accepted and ignored — and if a key
exists but nothing consults it (as `safety.allowForceTerminate` currently does), that has
to be said out loud in the "Not implemented yet" lists.

## Documentation changes

Every English document has a Chinese counterpart with the same structure and depth:
`README.md`/`README.zh.md`, and `docs/*.md`/`docs/*.zh.md`. When you change one, change
its pair in the same pull request. Do not let the Chinese file drift into a summary — it is
a translation, and a reader of it must be able to act on the same facts.

Claims in documentation must be verifiable in the source or reproducible with a command.
If something is not implemented, say so under a heading that says so. Several sections of
this repository's documentation exist purely to state a gap; that is deliberate, and
removing a gap statement without closing the gap is a regression.

## Commit and pull-request conventions

- One logical change per commit; a message in the imperative mood ("add ticket expiry
  check", not "added" / "fixes").
- Reference the design-document section you are implementing or diverging from.
- A pull request must state: what changed, which rule above it touches, how it was tested
  (the exact commands and their results), and whether a documented behaviour, a
  configuration key or the wire protocol changed.
- A protocol change needs a `PROTOCOL_VERSION`/`TICKET_SCHEMA_VERSION` decision and a
  compatibility note in [docs/protocol.md](docs/protocol.md).
- Never edit `lib/` by hand; it is build output.
- Keep line endings LF for everything except `.ps1` files, which the repository's
  `.gitattributes` normalises to CRLF.

## Reporting bugs

Include: the package version, `node --version`, the platform, the exact request (or tool
call) that failed, the `reason` code and `detail` string, and the relevant
`restart-attempts.jsonl` and `supervisor.log` lines. For a restart that did not happen,
`restart_status` plus the audit tail answers most questions immediately. Security issues
go through [SECURITY.md](SECURITY.md), not the public issue tracker.
