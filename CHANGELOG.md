# Changelog

All notable changes to this project are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this
project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). The
`PROTOCOL_VERSION` and `TICKET_SCHEMA_VERSION` constants version the wire and on-disk
contracts separately from the package version; see
[docs/protocol.md](docs/protocol.md#versioning-rules).

## [Unreleased]

Nothing yet.

## [0.1.0] - 2026-06-01

The first release: safe restart *execution*, with no opinion about when a restart is
warranted.

### Added

- **Request pipeline** — `RestartManager` with `requestApplicationRestart`,
  `requestSystemRestart`, `getRestartStatus`, `cancelPendingRestart`,
  `reconcileAfterRestart`, `tripCrashLoop` and `clearCrashLoop`.
- **Validation** — `validateShape` and `validateRequest`, with the ordered refusal codes
  `INVALID_REQUEST`, `DISABLED`, `UNKNOWN_SOURCE`, `MODE_NOT_ALLOWED`,
  `SYSTEM_REBOOT_NOT_PERMITTED`, `CRASH_LOOP`, `DUPLICATE_REQUEST_ID`,
  `RESTART_IN_FLIGHT`, `COOLDOWN_ACTIVE`, `CHECKPOINT_FAILED` and `SUPERVISOR_ABSENT`;
  the pipeline adds `CHECKPOINT_REQUIRED`, `TICKET_WRITE_FAILED` and
  `SHUTDOWN_PORT_UNAVAILABLE`.
- **Exclusive restart lock** — `RestartLock` with declared transitions, a request-id
  holder, bounded transition history, and a refusal that names the states it would have
  allowed.
- **Checkpoint gate** — `CheckpointGate` with a hard timeout, `UnboundCheckpointPort` as
  the refusal-by-default seam, and `FileCheckpointPort` / `FunctionCheckpointPort` as real
  implementations. A missing, unsafe, incomplete, thrown or timed-out checkpoint aborts
  the restart.
- **Ticket store** — atomic writes (temp file → `fsync` → `rename`), `TICKET_SCHEMA_VERSION`,
  `sha256` checksum over canonical JSON, and six verification rejections: `missing`,
  `schema_version`, `checksum`, `expired`, `wrong_pid`, `malformed`.
- **Audit log** — bounded, append-only `restart-attempts.jsonl` with a schema version,
  rotation at `storage.maxLogBytes`, tolerant reading of a half-written trailing line, and
  an in-memory ring for `restart_status`.
- **External supervisor** — `RestartSupervisor` with the documented state machine,
  `SystemLivenessProbe` (signal 0, then `tasklist.exe` on Windows or `ps` elsewhere),
  `CrashLoopBreaker` with a rolling window, `HeartbeatWriter`, `ChildProcessLauncher`, and
  bounded event history.
- **Crash-loop breaker** — trips at `safety.crashLoopLimit` unclean starts inside
  `safety.crashLoopWindowMs`, persists to `ledger.json`, restores a tripped state at
  startup, and enters safe mode when `safety.safeModeOnLoop` is true.
- **Cordis integration** — `name`, `inject` (empty: nothing is required), `apply`,
  `applyRestart`, the `restart` settings namespace, and the three model-facing tools
  `restart_status`, `restart_request` and `restart_cancel`.
- **Configuration** — `DEFAULT_CONFIG`, `deepMerge`, `resolveConfig`, `tryResolveConfig`
  and `ConfigError`, refusing any document it could not enforce and naming the dotted path.
- **Bundle patch** — `cordis.patch.yml`, inserting one row with every configuration key at
  its default and a comment on the effect and risk of each.
- **Helper scripts** — `scripts/install.ps1`, `uninstall.ps1`, `enable.ps1` and
  `disable.ps1`, each declaring `#Requires -Version 5.1` (nothing in them is
  PowerShell-7-only, and 5.1 is the widest truthful requirement; they work on 7 too),
  each supporting `-WhatIf`, each ending in an explicit summary and a non-zero exit on
  failure.
- **Artifact check** — `scripts/verify-artifacts.mjs`, wired to `npm run verify:artifacts`.
- **Test suite** — 156 tests across 25 suites in `tests/`, driving the real classes through
  injected seams.
- **Documentation** — this changelog, `README.md` and `README.zh.md`, `docs/architecture.md`,
  `docs/protocol.md`, `docs/failure-modes.md`, `docs/acceptance.md`, `docs/operations.md`,
  `CONTRIBUTING.md` and `SECURITY.md`, each with a Chinese counterpart.

### Fixed

Two defects in the supervisor entry point that made it unusable on Windows, both found
and fixed before the first release:

- `bin/supervisor.mjs` compared `import.meta.url` against a hand-built `file://D:/...`
  string. On Windows the real URL is `file:///D:/...`, so `isMain` was never true: running
  `node bin/supervisor.mjs` did nothing and exited 0. It now uses `pathToFileURL`.
  `npm run verify:artifacts` asserts that `--help` exits 0 *and* prints usage.
- every timer inside `src/supervisor/index.ts` is `unref`'d by design, so a bare `run()`
  had nothing holding the event loop open and drained after the first tick: the supervisor
  logged `supervisor_boot` and exited without supervising. The entry point now holds the
  loop open for the duration of the run and releases it at a terminal state.

### Known limitations

Recorded here because they are behavioural gaps, not documentation gaps. Each is described
in full under "Not implemented yet" in [README.md](README.md#not-implemented-yet):

- the system-reboot port is implemented and exported but **never called** by the pipeline,
  so `mode: "system"` does not reboot the machine;
- `safety.allowForceTerminate` is read after `safety.shutdownTimeoutMs` expires, but only
  with a bound `ProcessTerminator`; the shipped supervisor binds one only when the setting is
  on. Before that deadline existed, a hung graceful shutdown was waited on and no "dirty restart" was
  recorded;
- `acknowledgeResume` is implemented but never called by the pipeline;
- relaunch retries are paced by a doubling backoff up to `supervisor.relaunchBackoffMaxMs`, on top of the crash-loop breaker;
- safe mode stops relaunching rather than launching a degraded DS-Hns;
- the supervisor process never reads the profile configuration (`bin/supervisor.mjs` calls
  `resolveConfig()` with no overrides), so profile-level `supervisor.*` tuning affects the
  plugin's expectations but not the supervisor's behaviour;
- `supervisor.detach` is declared, defaulted and validated but read only by the uncalled
  `spawnSupervisor()`; the relaunch launcher hard-codes `detached: false`;
- `supervisor.log` is append-only and never rotated, unlike the audit log;
- cooldowns, the duplicate ledger and the plugin-side crash-loop flag are per-process and
  do not survive the restart they gate;
- `spawnSupervisor()` is exported but never called: the plugin does not start the
  supervisor;
- relaunch verification is by pid liveness, not by an application heartbeat, despite the
  `WAITING_FOR_HEARTBEAT` state name;
- no Windows E2E evidence is included in this repository.

[Unreleased]: https://github.com/dsh-restart/dsh-restart/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/dsh-restart/dsh-restart/releases/tag/v0.1.0
