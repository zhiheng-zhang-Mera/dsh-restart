/**
 * Shared test harness for `dsh-restart`.
 *
 * Every seam the plugin has is injected, so the tests drive the real
 * `RestartManager` and the real `RestartSupervisor` with a fake clock, a fake
 * checkpoint, a fake lifecycle and a fake process list. Nothing here shells out
 * and nothing reboots anything.
 */

import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { resolveConfig } from '../../lib/shared/config.js'
import { RestartManager } from '../../lib/plugin/restart-manager.js'
import { RestartAuditLog } from '../../lib/plugin/audit.js'
import { TicketStore } from '../../lib/plugin/ticket-store.js'
import { FunctionCheckpointPort, HostShutdownPort, RecordingLifecycle } from '../../lib/plugin/ports.js'
import { checkpoints } from './checkpoints.js'

export const T0 = Date.parse('2026-06-01T00:00:00.000Z')
export const MINUTE = 60_000
export const SECOND = 1_000

/** Refusal codes, so a rename in the source breaks exactly one file. */
export const RefusalCodes = Object.freeze({
  DUPLICATE_REQUEST_ID: 'DUPLICATE_REQUEST_ID',
  UNKNOWN_SOURCE: 'UNKNOWN_SOURCE',
  MODE_NOT_ALLOWED: 'MODE_NOT_ALLOWED',
  SYSTEM_REBOOT_NOT_PERMITTED: 'SYSTEM_REBOOT_NOT_PERMITTED',
  RESTART_IN_FLIGHT: 'RESTART_IN_FLIGHT',
  COOLDOWN_ACTIVE: 'COOLDOWN_ACTIVE',
  CHECKPOINT_REQUIRED: 'CHECKPOINT_REQUIRED',
  CHECKPOINT_FAILED: 'CHECKPOINT_FAILED',
  SUPERVISOR_ABSENT: 'SUPERVISOR_ABSENT',
  CRASH_LOOP: 'CRASH_LOOP',
  INVALID_REQUEST: 'INVALID_REQUEST',
  DISABLED: 'DISABLED',
  SHUTDOWN_PORT_UNAVAILABLE: 'SHUTDOWN_PORT_UNAVAILABLE',
})

/** A complete, valid request with room to override any field. */
export function validRequest(overrides = {}) {
  return {
    requestId: 'req-1',
    source: 'dsh-health-scheduler',
    mode: 'application',
    reasonCode: 'RUNTIME_PRESSURE',
    reasonSummary: 'runtime health policy requested an application restart',
    checkpointRequired: true,
    priority: 'normal',
    createdAt: new Date(T0).toISOString(),
    ...overrides,
  }
}

/**
 * A rig around the real manager.
 *
 * `advance(ms)` moves the fake clock; `supervise()` writes a fresh heartbeat so
 * the manager sees a live supervisor, which is a precondition for every real
 * restart.
 */
export class RestartRig {
  constructor(options = {}) {
    this.now = options.now ?? T0
    this.directory = options.directory ?? mkdtempSync(join(tmpdir(), 'dsh-restart-'))
    this.ownsDirectory = options.directory === undefined
    this.config = resolveConfig(options.config ?? {})
    this.store = new TicketStore(this.directory, { now: () => this.now })
    this.audit = new RestartAuditLog({
      directory: this.directory,
      maxBytes: 1024 * 1024,
      maxRecords: this.config.storage.maxRecentAttempts,
      now: () => this.now,
    })
    this.lifecycle = options.lifecycle ?? new RecordingLifecycle()
    this.checkpoint = options.checkpoint ?? checkpoints.ok()
    // `undefined` means "the rig supplies a scripted port"; `null` explicitly means
    // this machine cannot reboot, which is the case worth testing.
    this.systemShutdown =
      options.systemShutdown === undefined
        ? {
            id: 'scripted-system',
            requests: [],
            requestSystemRestart(reason, delaySeconds) {
              this.requests.push({ reason, delaySeconds })
              return true
            },
          }
        : options.systemShutdown
    this.manager = new RestartManager({
      config: this.config,
      ports: {
        checkpoint: this.checkpoint,
        shutdown: new HostShutdownPort(this.lifecycle),
        systemShutdown: this.systemShutdown,
      },
      store: this.store,
      audit: this.audit,
      pid: options.pid ?? 4242,
      now: () => this.now,
      processAlive: options.processAlive ?? (() => true),
    })
    /** Every ticket the supervisor would have seen, newest last. */
    this.tickets = []
    this.publishHeartbeat()
  }

  /** Move the fake clock forward. */
  advance(ms) {
    this.now += ms
    return this
  }

  /** Write a heartbeat as if the supervisor were running. */
  publishHeartbeat(options = {}) {
    this.store.writeHeartbeat({
      schemaVersion: 1,
      supervisorPid: options.supervisorPid ?? 999,
      watchedPid: options.watchedPid ?? 4242,
      state: options.state ?? 'MONITORING',
      timestamp: new Date(this.now).toISOString(),
      sequence: options.sequence ?? 1,
    })
    return this
  }

  /** Submit a request and remember the ticket it produced. */
  async request(overrides = {}) {
    const response = await this.manager.requestApplicationRestart(validRequest(overrides))
    this.captureTicket()
    return response
  }

  /** Submit a system request. */
  async requestSystem(overrides = {}) {
    const response = await this.manager.requestSystemRestart(
      validRequest({ mode: 'system', reasonCode: 'SYSTEM_PRESSURE', acknowledgeSystemReboot: true, ...overrides }),
    )
    this.captureTicket()
    return response
  }

  /** Record the ticket currently on disk, if any. */
  captureTicket() {
    const verification = this.store.readTicket(this.now)
    if (verification.valid && verification.ticket !== null) this.tickets.push(verification.ticket)
    return verification
  }

  /** The pending ticket, verified. */
  pendingTicket() {
    return this.store.readTicket(this.now)
  }

  dispose() {
    if (this.ownsDirectory) rmSync(this.directory, { recursive: true, force: true })
  }
}

export { checkpoints, FunctionCheckpointPort, RecordingLifecycle }
