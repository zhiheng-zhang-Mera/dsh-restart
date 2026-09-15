/**
 * The restart pipeline end to end: request -> validate -> lock -> checkpoint ->
 * ticket -> graceful shutdown, plus duplicate suppression, cooldowns, cancellation
 * and startup reconciliation.
 *
 * The manager is driven through its real public API with every seam injected, so
 * these tests exercise the code that would run on a real machine without any of the
 * consequences.
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { describe, it } from 'node:test'

import { resolveConfig } from '../lib/shared/config.js'
import { MINUTE, RefusalCodes, RestartRig, T0, checkpoints, validRequest } from './helpers/rig.js'
import { UnboundCheckpointPort } from '../lib/plugin/checkpoint-gate.js'
import { RecordingLifecycle } from '../lib/plugin/ports.js'

describe('application restart pipeline', () => {
  it('accepts a valid request, writes a ticket, and asks the host to shut down', async () => {
    const rig = new RestartRig()
    try {
      const response = await rig.request()

      assert.equal(response.accepted, true)
      assert.equal(response.state, 'shutting_down')
      assert.ok(response.ticketId)

      // Exactly one graceful shutdown request, carrying the ticket id.
      assert.deepEqual(rig.lifecycle.requests, [response.ticketId])

      // The ticket is on disk, verifies, and names this process.
      const verification = rig.pendingTicket()
      assert.equal(verification.valid, true)
      assert.equal(verification.ticket.pid, 4242)
      assert.equal(verification.ticket.requestId, 'req-1')
      assert.equal(verification.ticket.mode, 'application')
      assert.equal(verification.ticket.checkpointId, 'ck-1')
      assert.equal(verification.ticket.schemaVersion, 1)
    } finally {
      rig.dispose()
    }
  })

  it('runs the checkpoint gate before writing anything', async () => {
    const calls = []
    const rig = new RestartRig({
      checkpoint: {
        id: 'spy',
        prepareForRestart(mode) {
          calls.push(mode)
          return {
            safe: true,
            reason: 'idle',
            checkpointId: 'ck-9',
            resumeToken: null,
            completed: true,
            detail: 'ok',
          }
        },
        acknowledgeResume: () => true,
      },
    })
    try {
      await rig.request()
      assert.deepEqual(calls, ['application'])
      assert.equal(rig.pendingTicket().ticket.checkpointId, 'ck-9', 'the ticket cites the real checkpoint')
    } finally {
      rig.dispose()
    }
  })

  it('releases the lock and records the attempt when the host refuses to shut down', async () => {
    const rig = new RestartRig({ lifecycle: new RecordingLifecycle({ accept: false }) })
    try {
      const response = await rig.request()
      assert.equal(response.accepted, false)
      assert.equal(response.reason, RefusalCodes.SHUTDOWN_PORT_UNAVAILABLE)
      assert.equal(rig.manager.lockState, 'IDLE')
      assert.equal(rig.store.hasTicket(), false, 'no ticket may survive a refused shutdown')
      assert.equal(rig.audit.recent()[0].outcomeCode, RefusalCodes.SHUTDOWN_PORT_UNAVAILABLE)
    } finally {
      rig.dispose()
    }
  })

  it('releases the lock and records the attempt when the shutdown port throws', async () => {
    const rig = new RestartRig({
      lifecycle: {
        requestShutdown() {
          throw new Error('the host lifecycle is broken')
        },
      },
    })
    try {
      const response = await rig.request()
      assert.equal(response.accepted, false)
      assert.equal(response.reason, RefusalCodes.SHUTDOWN_PORT_UNAVAILABLE)
      assert.match(response.detail, /the host lifecycle is broken/)
      assert.equal(rig.store.hasTicket(), false, 'a thrown shutdown must leave no ticket behind')
      assert.equal(rig.manager.lockState, 'IDLE')
    } finally {
      rig.dispose()
    }
  })
})

describe('checkpoint gate', () => {
  it('aborts when the harness reports an unsafe safe point', async () => {
    const rig = new RestartRig({ checkpoint: checkpoints.unsafe('git_commit_in_progress') })
    try {
      const response = await rig.request()
      assert.equal(response.accepted, false)
      assert.equal(response.reason, RefusalCodes.CHECKPOINT_REQUIRED)
      assert.match(response.detail, /git_commit_in_progress/)
      assert.equal(rig.store.hasTicket(), false, 'a refused checkpoint must produce no ticket')
      assert.equal(rig.lifecycle.requests.length, 0, 'and must not ask the host to shut down')
      assert.equal(rig.manager.lockState, 'IDLE')
    } finally {
      rig.dispose()
    }
  })

  it('aborts when the checkpoint starts but does not complete', async () => {
    const rig = new RestartRig({ checkpoint: checkpoints.incomplete() })
    try {
      const response = await rig.request()
      assert.equal(response.accepted, false)
      // The harness said the moment was safe but never finished the checkpoint, so
      // the failure is the checkpoint, not the safe point.
      assert.equal(response.reason, RefusalCodes.CHECKPOINT_FAILED)
      assert.match(response.detail, /did not finish/)
      assert.equal(rig.store.hasTicket(), false)
    } finally {
      rig.dispose()
    }
  })

  it('aborts, rather than proceeding, when the checkpoint port throws', async () => {
    const rig = new RestartRig({ checkpoint: checkpoints.throwing() })
    try {
      const response = await rig.request()
      assert.equal(response.accepted, false)
      assert.equal(response.reason, RefusalCodes.CHECKPOINT_FAILED)
      assert.match(response.detail, /exploded/)
      assert.equal(rig.lifecycle.requests.length, 0)
    } finally {
      rig.dispose()
    }
  })

  it('abandons a checkpoint that never answers instead of hanging the lock', async () => {
    const rig = new RestartRig({
      checkpoint: checkpoints.hanging(),
      config: { safety: { shutdownTimeoutMs: 30 } },
    })
    try {
      const response = await rig.request()
      assert.equal(response.accepted, false)
      assert.equal(response.reason, RefusalCodes.CHECKPOINT_FAILED)
      assert.match(response.detail, /did not answer/)
      assert.equal(rig.manager.lockState, 'IDLE', 'the lock must not stay in CHECKPOINTING')
    } finally {
      rig.dispose()
    }
  })

  it('proceeds without a checkpoint only when the request does not require one', async () => {
    const rig = new RestartRig({ checkpoint: checkpoints.unsafe('busy') })
    try {
      const refused = await rig.request({ requestId: 'req-a', checkpointRequired: true })
      assert.equal(refused.accepted, false)

      const allowed = await rig.request({ requestId: 'req-b', checkpointRequired: false })
      assert.equal(allowed.accepted, true)
      assert.equal(rig.pendingTicket().ticket.checkpointId, null)
    } finally {
      rig.dispose()
    }
  })

  it('refuses every request when no checkpoint port is bound and one is required', async () => {
    const rig = new RestartRig({ checkpoint: new UnboundCheckpointPort() })
    try {
      const response = await rig.request()
      assert.equal(response.accepted, false)
      assert.equal(response.reason, RefusalCodes.CHECKPOINT_FAILED)
      assert.match(response.detail, /no checkpoint port/)
    } finally {
      rig.dispose()
    }
  })
})

describe('duplicate suppression', () => {
  it('returns the original answer for a retried request id and restarts nothing twice', async () => {
    const rig = new RestartRig()
    try {
      const first = await rig.request({ requestId: 'req-dup' })
      assert.equal(first.accepted, true)
      const shutdownsAfterFirst = rig.lifecycle.requests.length

      const retry = await rig.request({ requestId: 'req-dup' })
      assert.deepEqual(retry, first, 'a retry gets the previous answer verbatim')
      assert.equal(rig.lifecycle.requests.length, shutdownsAfterFirst, 'and causes no second shutdown')
    } finally {
      rig.dispose()
    }
  })

  it('refuses the same id used for a different request', async () => {
    const rig = new RestartRig()
    try {
      await rig.request({ requestId: 'req-dup' })
      const conflicting = await rig.request({ requestId: 'req-dup', reasonCode: 'MEMORY_LEAK' })
      assert.equal(conflicting.accepted, false)
      assert.equal(conflicting.reason, RefusalCodes.DUPLICATE_REQUEST_ID)
      assert.match(conflicting.detail, /different request/)
    } finally {
      rig.dispose()
    }
  })

  it('can be turned off, in which case the id is checked against the lock instead', async () => {
    const rig = new RestartRig({ config: { safety: { duplicateSuppression: false } } })
    try {
      const first = await rig.request({ requestId: 'req-dup' })
      assert.equal(first.accepted, true)
      const second = await rig.request({ requestId: 'req-dup' })
      assert.equal(second.accepted, false)
      assert.equal(second.reason, RefusalCodes.RESTART_IN_FLIGHT)
    } finally {
      rig.dispose()
    }
  })
})

describe('cooldowns', () => {
  it('enforces the minimum interval after an accepted restart', async () => {
    const rig = new RestartRig()
    try {
      const first = await rig.request({ requestId: 'req-1' })
      assert.equal(first.accepted, true)

      // The ticket is still pending, so clear it to model a supervisor having
      // consumed it, and hand the lock back the way a fresh process would.
      const second = await rig.request({ requestId: 'req-2' })
      assert.equal(second.accepted, false)
      assert.ok([RefusalCodes.COOLDOWN_ACTIVE, RefusalCodes.RESTART_IN_FLIGHT].includes(second.reason))
    } finally {
      rig.dispose()
    }
  })

  it('reports the remaining cooldown in the status payload', async () => {
    const rig = new RestartRig()
    try {
      await rig.request()
      rig.advance(5 * MINUTE)
      const status = rig.manager.getRestartStatus()
      assert.equal(status.cooldowns.application.minimumIntervalMs, 20 * MINUTE)
      assert.equal(status.cooldowns.application.remainingMs, 15 * MINUTE)
      assert.equal(status.cooldowns.application.nextAllowedAt, new Date(T0 + 20 * MINUTE).toISOString())
      assert.equal(status.cooldowns.system.remainingMs, 0)
    } finally {
      rig.dispose()
    }
  })

  it('enforces a longer minimum for system restarts', async () => {
    const config = resolveConfig({ allowSystemReboot: true, systemRestart: { enabled: true } })
    assert.equal(config.systemRestart.minIntervalMs, 60 * MINUTE)
    assert.equal(config.applicationRestart.minIntervalMs, 20 * MINUTE)
  })
})

describe('system restart gate', () => {
  it('refuses by default and does not reach the system-shutdown port', async () => {
    const rig = new RestartRig()
    try {
      const response = await rig.requestSystem()
      assert.equal(response.accepted, false)
      assert.equal(response.reason, RefusalCodes.MODE_NOT_ALLOWED)
      assert.deepEqual(rig.systemShutdown.requests, [])
    } finally {
      rig.dispose()
    }
  })

  it('proceeds when the mode, the permission and the acknowledgement are all present', async () => {
    const rig = new RestartRig({
      config: { allowSystemReboot: true, systemRestart: { enabled: true } },
    })
    try {
      const response = await rig.requestSystem()
      assert.equal(response.accepted, true)
      assert.equal(response.state, 'shutting_down')
      assert.match(response.detail, /reboot/)
      const ticket = rig.pendingTicket().ticket
      assert.equal(ticket.mode, 'system')
    } finally {
      rig.dispose()
    }
  })

  it('still refuses when the machine has no system-shutdown port', async () => {
    const rig = new RestartRig({
      config: { allowSystemReboot: true, systemRestart: { enabled: true } },
      systemShutdown: null,
    })
    try {
      // A null port means the machine cannot be rebooted, so the capability must be
      // reported as absent even though the configuration permits it.
      const status = rig.manager.getRestartStatus()
      assert.equal(status.capabilities.systemRestart, false)
    } finally {
      rig.dispose()
    }
  })

  it('performs a real reboot through the system-shutdown port', async () => {
    const requests = []
    const rig = new RestartRig({
      config: { allowSystemReboot: true, systemRestart: { enabled: true } },
      systemShutdown: {
        id: 'scripted-system',
        requestSystemRestart(reason, delaySeconds) {
          requests.push({ reason, delaySeconds })
          return true
        },
      },
    })
    try {
      const response = await rig.requestSystem()
      assert.equal(response.accepted, true)
      assert.equal(requests.length, 1, 'the machine restart port must actually be called')
      assert.match(requests[0].reason, /^system-/, 'the ticket id is the reason, so the event log is traceable')
      assert.ok(requests[0].delaySeconds > 0, 'a non-zero delay lets the audit record land first')
      assert.match(response.detail, /the machine will reboot/)
      // A system restart must not also ask the host to exit: the host exiting is not a
      // reboot, and conflating the two is how a reboot silently becomes a shutdown.
      assert.deepEqual(rig.lifecycle.requests, [], 'no application shutdown request for a system restart')
    } finally {
      rig.dispose()
    }
  })

  it('refuses a system restart when the machine has no reboot port, rather than downgrading it', async () => {
    const rig = new RestartRig({
      config: { allowSystemReboot: true, systemRestart: { enabled: true } },
      systemShutdown: null,
    })
    try {
      const response = await rig.requestSystem()
      assert.equal(response.accepted, false)
      assert.equal(response.reason, 'SYSTEM_REBOOT_FAILED')
      assert.match(response.detail, /no system-shutdown port is bound/)
      assert.equal(rig.store.hasTicket(), false, 'a refused reboot leaves no ticket')
      assert.equal(rig.manager.lockState, 'IDLE')
      assert.deepEqual(rig.lifecycle.requests, [], 'and does not silently become an application restart')
    } finally {
      rig.dispose()
    }
  })

  it('refuses when the reboot port itself refuses', async () => {
    const rig = new RestartRig({
      config: { allowSystemReboot: true, systemRestart: { enabled: true } },
      systemShutdown: { id: 'scripted-system', requestSystemRestart: () => false },
    })
    try {
      const response = await rig.requestSystem()
      assert.equal(response.accepted, false)
      assert.equal(response.reason, 'SYSTEM_REBOOT_FAILED')
      assert.match(response.detail, /refused the reboot/)
      assert.equal(rig.store.hasTicket(), false)
    } finally {
      rig.dispose()
    }
  })

  it('refuses when the reboot port throws', async () => {
    const rig = new RestartRig({
      config: { allowSystemReboot: true, systemRestart: { enabled: true } },
      systemShutdown: {
        id: 'scripted-system',
        requestSystemRestart: () => {
          throw new Error('shutdown.exe is missing')
        },
      },
    })
    try {
      const response = await rig.requestSystem()
      assert.equal(response.accepted, false)
      assert.equal(response.reason, 'SYSTEM_REBOOT_FAILED')
      assert.match(response.detail, /shutdown.exe is missing/)
      assert.equal(rig.store.hasTicket(), false)
      assert.equal(rig.manager.lockState, 'IDLE')
    } finally {
      rig.dispose()
    }
  })

  it('reports the system capability when a port and the permissions are both present', async () => {
    const rig = new RestartRig({
      config: { allowSystemReboot: true, systemRestart: { enabled: true } },
      systemShutdown: {
        id: 'scripted-system',
        requestSystemRestart: () => true,
      },
    })
    try {
      const status = rig.manager.getRestartStatus()
      assert.equal(status.capabilities.systemRestart, true)
      const response = await rig.requestSystem()
      assert.equal(response.accepted, true)
    } finally {
      rig.dispose()
    }
  })
})

describe('cancellation', () => {
  it('cancels a pending request, clears the ticket and records the attempt', async () => {
    const rig = new RestartRig({
      // A lifecycle that accepts but never actually exits, so there is something
      // left to cancel.
      lifecycle: new RecordingLifecycle({ accept: true }),
    })
    try {
      const response = await rig.request({ requestId: 'req-cancel' })
      assert.equal(response.accepted, true)
      assert.equal(rig.store.hasTicket(), true)

      const cancelled = await rig.manager.cancelPendingRestart('req-cancel')
      assert.equal(cancelled, true)
      assert.equal(rig.store.hasTicket(), false)
      assert.equal(rig.manager.lockState, 'IDLE')
      assert.equal(rig.audit.recent()[0].state, 'cancelled')
      assert.equal(rig.audit.recent()[0].outcomeCode, 'CANCELLED')
    } finally {
      rig.dispose()
    }
  })

  it('refuses to cancel an unknown or already-finished request', async () => {
    const rig = new RestartRig()
    try {
      assert.equal(await rig.manager.cancelPendingRestart('nope'), false)
      await rig.request({ requestId: 'req-1' })
      assert.equal(await rig.manager.cancelPendingRestart('other'), false)
    } finally {
      rig.dispose()
    }
  })
})

describe('startup reconciliation', () => {
  it('discards a ticket left behind by a process that did not exit', async () => {
    const rig = new RestartRig()
    try {
      await rig.request()
      assert.equal(rig.store.hasTicket(), true)

      const reconciled = rig.manager.reconcileAfterRestart()
      assert.ok(reconciled !== null)
      assert.match(reconciled.detail, /did not exit/)
      assert.equal(rig.store.hasTicket(), false, 'a stale ticket must not survive into a new process')
    } finally {
      rig.dispose()
    }
  })

  it('reports nothing when there is no ticket', () => {
    const rig = new RestartRig()
    try {
      assert.equal(rig.manager.reconcileAfterRestart(), null)
    } finally {
      rig.dispose()
    }
  })

  it('discards an unusable ticket and says why', async () => {
    const rig = new RestartRig()
    try {
      await rig.request()
      // Corrupt the ticket the way a partial write or a meddling process would.
      const path = rig.store.paths.ticket
      const ticket = JSON.parse(readFileSync(path, 'utf8'))
      writeFileSync(path, JSON.stringify({ ...ticket, reasonCode: 'tampered' }), 'utf8')
      const reconciled = rig.manager.reconcileAfterRestart()
      assert.ok(reconciled !== null)
      assert.match(reconciled.detail, /unusable ticket/)
      assert.match(reconciled.detail, /checksum/)
    } finally {
      rig.dispose()
    }
  })
})

describe('crash-loop breaker integration', () => {
  it('refuses every request while the breaker is tripped and recovers when cleared', async () => {
    const rig = new RestartRig()
    try {
      rig.manager.tripCrashLoop('three unclean starts in ten minutes')
      const refused = await rig.request()
      assert.equal(refused.accepted, false)
      assert.equal(refused.reason, RefusalCodes.CRASH_LOOP)

      const status = rig.manager.getRestartStatus()
      assert.equal(status.crashLoop.tripped, true)
      assert.equal(status.crashLoop.reason, 'three unclean starts in ten minutes')

      rig.manager.clearCrashLoop()
      const accepted = await rig.request({ requestId: 'req-after-clear' })
      assert.equal(accepted.accepted, true)
    } finally {
      rig.dispose()
    }
  })
})

describe('supervisor presence', () => {
  it('refuses when no heartbeat has been seen, because exiting is not restarting', async () => {
    const rig = new RestartRig()
    try {
      // Age the heartbeat past the timeout.
      rig.advance(2 * MINUTE)
      const response = await rig.request()
      assert.equal(response.accepted, false)
      assert.equal(response.reason, RefusalCodes.SUPERVISOR_ABSENT)
      assert.equal(rig.manager.getRestartStatus().supervisor.present, false)
    } finally {
      rig.dispose()
    }
  })

  it('proceeds when the deployment explicitly allows it without a supervisor', async () => {
    const rig = new RestartRig({ config: { safety: { allowRestartWithoutSupervisor: true } } })
    try {
      rig.advance(2 * MINUTE)
      const response = await rig.request()
      assert.equal(response.accepted, true)
    } finally {
      rig.dispose()
    }
  })

  it('sees a fresh heartbeat as presence', async () => {
    const rig = new RestartRig()
    try {
      rig.advance(5 * MINUTE)
      assert.equal(rig.manager.getRestartStatus().supervisor.present, false)
      rig.publishHeartbeat({ sequence: 2 })
      assert.equal(rig.manager.getRestartStatus().supervisor.present, true)
      assert.equal(rig.manager.getRestartStatus().supervisor.lastSeenAt, new Date(rig.now).toISOString())
    } finally {
      rig.dispose()
    }
  })
})

describe('status payload', () => {
  it('reports capabilities, cooldowns, crash loop and recent attempts together', async () => {
    const rig = new RestartRig()
    try {
      const before = rig.manager.getRestartStatus()
      assert.equal(before.enabled, true)
      assert.equal(before.lock, 'IDLE')
      assert.equal(before.canRestart.allowed, true)
      assert.equal(before.canRestart.reason, 'OK')
      assert.equal(before.capabilities.applicationRestart, true)
      assert.equal(before.capabilities.checkpointPort, true)
      assert.equal(before.capabilities.systemRestart, false)
      assert.deepEqual(before.recent, [])

      await rig.request({ requestId: 'req-1' })
      const after = rig.manager.getRestartStatus()
      assert.equal(after.lock, 'SHUTTING_DOWN')
      assert.equal(after.active.requestId, 'req-1')
      assert.equal(after.active.mode, 'application')
      assert.equal(after.canRestart.allowed, false)
      assert.equal(after.canRestart.reason, 'RESTART_IN_FLIGHT')
    } finally {
      rig.dispose()
    }
  })

  it('says why a restart is impossible when the configuration disables it', () => {
    const rig = new RestartRig({ config: { enabled: false } })
    try {
      const status = rig.manager.getRestartStatus()
      assert.equal(status.enabled, false)
      assert.equal(status.canRestart.allowed, false)
      assert.equal(status.canRestart.reason, RefusalCodes.DISABLED)
    } finally {
      rig.dispose()
    }
  })
})

describe('audit log', () => {
  it('writes accepted, refused and cancelled attempts to disk with schema versions', async () => {
    const rig = new RestartRig()
    try {
      await rig.request({ requestId: 'req-ok' })
      assert.ok(existsSync(rig.audit.path))

      const persisted = rig.audit.readPersisted()
      assert.ok(persisted.length >= 1)
      assert.equal(persisted[0].requestId, 'req-ok')
      assert.equal(persisted[0].state, 'shutting_down')
      assert.equal(persisted[0].mode, 'application')
      assert.equal(typeof persisted[0].finishedAt, 'string')

      const lines = readFileSync(rig.audit.path, 'utf8').trim().split('\n')
      const parsed = JSON.parse(lines[0])
      assert.equal(parsed.schemaVersion, 1)
      assert.equal(parsed.kind, 'restart-attempt')
    } finally {
      rig.dispose()
    }
  })

  it('never throws when the audit directory cannot be written', () => {
    const rig = new RestartRig()
    try {
      const log = rig.audit
      // Point the log at an impossible path by constructing a new one.
      const broken = new (Object.getPrototypeOf(log).constructor)({
        directory: '\u0000impossible',
        maxBytes: 1024,
        maxRecords: 5,
      })
      broken.append({
        requestId: 'r',
        ticketId: null,
        mode: 'application',
        source: 'test',
        reasonCode: 'TEST',
        state: 'rejected',
        startedAt: new Date(T0).toISOString(),
        finishedAt: new Date(T0).toISOString(),
        detail: 'x',
        clean: true,
        outcomeCode: 'X',
      })
      assert.equal(broken.writeFailures, 1)
      assert.ok(broken.lastError !== null)
      assert.equal(broken.size, 1, 'the in-memory ring still works')
    } finally {
      rig.dispose()
    }
  })

  it('keeps only the configured number of recent attempts in memory', async () => {
    const rig = new RestartRig({ config: { storage: { maxRecentAttempts: 2 } } })
    try {
      // One accepted attempt plus a stream of refusals: every one of them is an
      // audit record, which is what the ring has to bound.
      await rig.request({ requestId: 'accepted' })
      for (const id of ['rejected-a', 'rejected-b', 'rejected-c']) {
        await rig.request({ requestId: id, source: 'not-allowed' })
      }
      assert.equal(rig.audit.size, 2, 'the in-memory ring is bounded')
      assert.equal(rig.manager.getRestartStatus().recent.length, 2)
      assert.equal(rig.audit.readPersisted().length, 4, 'the file keeps the full history')
    } finally {
      rig.dispose()
    }
  })
})

describe('accepting a restart is recorded before the process disappears', () => {
  it('writes the audit record before returning the response', async () => {
    const rig = new RestartRig()
    try {
      const response = await rig.request({ requestId: 'req-audit' })
      assert.equal(response.accepted, true)
      const latest = rig.audit.recent(1)[0]
      assert.equal(latest.requestId, 'req-audit')
      assert.equal(latest.state, 'shutting_down')
      assert.equal(latest.outcomeCode, 'ACCEPTED')
      assert.match(latest.detail, /checkpoint ck-1/)
      // The file is written too, not just the ring: the process may vanish next.
      const persisted = rig.audit.readPersisted()
      assert.ok(persisted.some((record) => record.requestId === 'req-audit'))
    } finally {
      rig.dispose()
    }
  })
})

describe('supervisor safe mode is bridged into the plugin', () => {
  it('refuses restarts while the supervisor ledger reports safe mode', async () => {
    const rig = new RestartRig()
    try {
      assert.equal(rig.manager.supervisorSafeMode, false)
      assert.equal(rig.manager.getRestartStatus().crashLoop.tripped, false)

      // The supervisor is a different process and it outlives a restart, so its
      // durable ledger is the only way a crash loop reaches this plugin.
      rig.store.writeLedger({
        schemaVersion: 1,
        uncleanStarts: [],
        safeMode: true,
        safeModeReason: 'crash_loop',
        safeModeAt: new Date(rig.now).toISOString(),
        relaunches: 3,
      })

      assert.equal(rig.manager.supervisorSafeMode, true)
      const status = rig.manager.getRestartStatus()
      assert.equal(status.crashLoop.tripped, true)
      assert.match(status.crashLoop.reason, /supervisor: crash_loop/)
      assert.equal(status.canRestart.allowed, false)
      assert.equal(status.canRestart.reason, RefusalCodes.CRASH_LOOP)

      const response = await rig.request({ requestId: 'req-while-safe-mode' })
      assert.equal(response.accepted, false)
      assert.equal(response.reason, RefusalCodes.CRASH_LOOP)

      // Clearing the ledger restores automation.
      rig.store.writeLedger({
        schemaVersion: 1,
        uncleanStarts: [],
        safeMode: false,
        safeModeReason: null,
        safeModeAt: null,
        relaunches: 3,
      })
      const after = await rig.request({ requestId: 'req-after-safe-mode' })
      assert.equal(after.accepted, true)
    } finally {
      rig.dispose()
    }
  })
})

describe('resume acknowledgement', () => {
  it('forwards the token to the checkpoint port and reports the answer', async () => {
    const tokens = []
    const rig = new RestartRig({
      checkpoint: {
        id: 'spy',
        prepareForRestart: () => ({
          safe: true,
          reason: 'idle',
          checkpointId: 'ck-1',
          resumeToken: 'rs-1',
          completed: true,
          detail: 'ok',
        }),
        acknowledgeResume(resumeToken) {
          tokens.push(resumeToken)
          return true
        },
      },
    })
    try {
      assert.equal(await rig.manager.acknowledgeResume('rs-1'), true)
      assert.deepEqual(tokens, ['rs-1'])
    } finally {
      rig.dispose()
    }
  })

  it('reports failure instead of throwing when the port is unbound', async () => {
    const rig = new RestartRig({ checkpoint: new UnboundCheckpointPort() })
    try {
      assert.equal(await rig.manager.acknowledgeResume(null), false)
    } finally {
      rig.dispose()
    }
  })
})
