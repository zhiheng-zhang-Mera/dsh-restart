/**
 * The restart service.
 *
 * This is the whole of `dsh-restart`'s behaviour, and it is deliberately narrow:
 *
 * ```
 * request -> validate -> lock -> checkpoint -> ticket -> graceful shutdown
 *         -> supervisor observes the exit -> relaunch -> resume
 * ```
 *
 * At no point does this class kill a process, signal a pid, or call into the host's
 * lifecycle directly. It writes a ticket, and it asks the host to shut itself down
 * through a port. The supervisor — a separate process — owns everything after that.
 *
 * It also has no opinion about *when* a restart is wanted. There is no clock in
 * here except the one that enforces cooldowns, and no threshold except the ones the
 * design lists as safety floors.
 *
 * @module dsh-restart/restart-manager
 */

import { randomUUID } from 'node:crypto'
import type { RestartConfig } from '../shared/types.js'
import type {
  CheckpointPort,
  NormalizedRequest,
  ShutdownPort,
  SystemShutdownPort,
} from '../shared/types.js'
import type {
  CooldownState,
  CrashLoopState,
  RestartActiveRequest,
  RestartAttemptRecord,
  RestartLockState,
  RestartMode,
  RestartRequest,
  RestartRequestState,
  RestartResponse,
  RestartStatus,
  SupervisorPresence,
} from '../shared/protocol.js'
import { RestartAuditLog } from './audit.js'
import { CheckpointGate } from './checkpoint-gate.js'
import { RestartLock } from './restart-lock.js'
import { buildTicket, type TicketStore } from './ticket-store.js'
import { requestFingerprint, validateRequest, validateShape } from './request-validator.js'

/**
 * Seconds between an accepted system restart and the reboot itself.
 *
 * Non-zero on purpose: the ticket, the audit record and the response all have to be
 * durable before the machine goes down, or the restart leaves no trace of why it
 * happened.
 */
const SYSTEM_REBOOT_DELAY_SECONDS = 15

/** Ports the service needs. Everything is injected, so every path is testable. */
export interface RestartManagerPorts {
  readonly checkpoint: CheckpointPort
  readonly shutdown: ShutdownPort
  /** Present only when a system reboot is actually possible on this machine. */
  readonly systemShutdown: SystemShutdownPort | null
}

/** Options for {@link RestartManager}. */
export interface RestartManagerOptions {
  readonly config: RestartConfig
  readonly ports: RestartManagerPorts
  readonly store: TicketStore
  readonly audit: RestartAuditLog
  /** Process id the supervisor should watch. Defaults to this process. */
  readonly pid?: number
  /** Injectable clock. */
  readonly now?: () => number
  /**
   * Whether the watched process is still running. Defaults to asking the operating
   * system. Injectable so a test can model "the host ignored the shutdown".
   */
  readonly processAlive?: (() => boolean) | null
  /** Observer for audit records, e.g. to mirror them into a host log. */
  readonly onAttempt?: (record: RestartAttemptRecord) => void
}

/** Internal bookkeeping for the in-flight request. */
interface ActiveRequest {
  readonly normalized: NormalizedRequest
  readonly ticketId: string
  state: RestartRequestState
  readonly createdAtMs: number
  updatedAtMs: number
  attempts: number
}

/**
 * The restart service.
 *
 * One instance per process. It holds the lock, the cooldown deadlines, the
 * duplicate ledger and the crash-loop view, and it is the only place a ticket is
 * ever written.
 */
export class RestartManager {
  private readonly config: RestartConfig
  private readonly ports: RestartManagerPorts
  private readonly store: TicketStore
  private readonly audit: RestartAuditLog
  private readonly now: () => number
  private readonly pid: number
  private readonly onAttempt: ((record: RestartAttemptRecord) => void) | null
  private readonly processAlive: (() => boolean) | null
  private readonly gate: CheckpointGate
  private readonly lock: RestartLock

  /** Request ids already processed, with the response they produced. */
  private readonly seen = new Map<string, { readonly fingerprint: string; readonly response: RestartResponse; readonly atMs: number }>()
  /** Cooldown deadlines per mode. */
  private readonly cooldownUntil: Record<RestartMode, number> = { application: 0, system: 0 }
  private active: ActiveRequest | null = null
  private crashLoopTripped = false
  private crashLoopReason: string | null = null
  private crashLoopTrippedAtMs: number | null = null

  constructor(options: RestartManagerOptions) {
    this.config = options.config
    this.ports = options.ports
    this.store = options.store
    this.audit = options.audit
    this.now = options.now ?? (() => Date.now())
    this.pid = options.pid ?? process.pid
    this.onAttempt = options.onAttempt ?? null
    this.processAlive = options.processAlive ?? null
    this.gate = new CheckpointGate({
      port: options.ports.checkpoint,
      // The checkpoint budget is the shutdown budget: a checkpoint that has not
      // answered by the time the process would have to stop is not a checkpoint.
      timeoutMs: options.config.safety.shutdownTimeoutMs,
      now: this.now,
    })
    this.lock = new RestartLock({ now: this.now })
  }

  // ---------------------------------------------------------------- public API

  /**
   * Submit a restart request.
   *
   * Returns as soon as the request is accepted. For an application restart the
   * process is expected to exit shortly afterwards, so "accepted" is the strongest
   * answer that can exist; `getRestartStatus()` and the audit log carry the rest.
   */
  async requestApplicationRestart(request: RestartRequest): Promise<RestartResponse> {
    return this.handle(request, 'application')
  }

  /** Submit a system restart request. Requires the extra permission and acknowledgement. */
  async requestSystemRestart(request: RestartRequest): Promise<RestartResponse> {
    return this.handle(request, 'system')
  }

  /** The current restart picture. */
  getRestartStatus(): RestartStatus {
    const nowMs = this.now()
    return {
      timestamp: new Date(nowMs).toISOString(),
      enabled: this.config.enabled,
      lock: this.lock.state,
      active: this.activeView(),
      canRestart: this.canRestart(nowMs),
      cooldowns: {
        application: this.cooldownView('application', nowMs),
        system: this.cooldownView('system', nowMs),
      },
      recent: this.audit.recent(),
      crashLoop: this.crashLoopView(),
      supervisor: this.supervisorView(nowMs),
      capabilities: {
        applicationRestart: this.config.applicationRestart.enabled,
        systemRestart:
          this.config.systemRestart.enabled && this.config.allowSystemReboot && this.ports.systemShutdown !== null,
        checkpointPort: this.gate.available,
        shutdownPort: true,
        supervisorWatch: true,
      },
    }
  }

  /**
   * Cancel a pending request.
   *
   * Only meaningful before the shutdown request has been issued; once the process
   * is on its way out there is nothing left to cancel and the ticket is cleared so
   * the supervisor does not relaunch a process nobody asked to restart.
   */
  async cancelPendingRestart(requestId: string): Promise<boolean> {
    const active = this.active
    if (active === null) return false
    if (active.normalized.requestId !== requestId) return false
    if (active.state === 'relaunching' || active.state === 'verifying') return false
    // In SHUTTING_DOWN the host has been asked to exit but may not have done so. If
    // this process is still running, the request never took effect and cancelling is
    // still meaningful; if it is gone, the ticket belongs to the supervisor.
    if (active.state === 'shutting_down' && !this.processStillRunning()) return false

    this.store.clearTicket()
    this.lock.release('cancel_requested')
    this.record({
      requestId,
      ticketId: active.ticketId,
      mode: active.normalized.mode,
      source: active.normalized.source,
      reasonCode: active.normalized.reasonCode,
      state: 'cancelled',
      startedAtMs: active.createdAtMs,
      detail: 'the requester cancelled the pending restart',
      clean: true,
      outcomeCode: 'CANCELLED',
    })
    this.active = null
    return true
  }

  /** Whether this process is still running, i.e. the shutdown has not taken effect. */
  private processStillRunning(): boolean {
    if (this.processAlive !== null) return this.processAlive()
    try {
      process.kill(this.pid, 0)
      return true
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === 'EPERM'
    }
  }

  /**
   * Reconcile state left behind by a previous process.
   *
   * Called once at startup. A ticket that is still on disk means a restart was
   * requested but this process never exited — the shutdown failed, or the host
   * ignored it. Either way the ticket must not be left where a supervisor could
   * act on it later, so it is invalidated and reported.
   *
   * @returns a description of what was reconciled, or `null` when there was nothing.
   */
  reconcileAfterRestart(): { readonly ticketId: string; readonly detail: string } | null {
    if (!this.store.hasTicket()) return null
    const nowMs = this.now()
    // Any ticket present at startup belongs to a previous process: this one has
    // just begun, so its own pid can differ (supervisor relaunch) and the old
    // ticket's pid is certainly not running any more.
    const verification = this.store.readTicket(nowMs)
    this.store.clearTicket()
    const detail =
      verification.valid && verification.ticket !== null
        ? `discarded a pending ticket from request ${verification.ticket.requestId} (written ${verification.ticket.createdAt}); the previous process did not exit`
        : `discarded an unusable ticket (${verification.rejection ?? 'unknown'}: ${verification.detail})`
    return { ticketId: verification.ticket?.ticketId ?? 'unknown', detail }
  }

  /** Mark the crash-loop breaker tripped, disabling automatic restart. */
  tripCrashLoop(reason: string): void {
    this.crashLoopTripped = true
    this.crashLoopReason = reason
    this.crashLoopTrippedAtMs = this.now()
  }

  /** Clear the crash-loop breaker held in this process. */
  clearCrashLoop(): void {
    this.crashLoopTripped = false
    this.crashLoopReason = null
    this.crashLoopTrippedAtMs = null
  }

  /**
   * Tell the harness that a checkpoint was consumed by a successful restart.
   *
   * The supervisor calls this the moment a relaunch is observed alive. It is the last
   * step of the restart flow, and its failure is reported rather than thrown: the
   * harness is up, and a bookkeeping call that did not land is not a reason to
   * pretend the restart failed.
   */
  async acknowledgeResume(resumeToken: string | null): Promise<boolean> {
    return this.gate.acknowledgeResume(resumeToken)
  }

  // ------------------------------------------------------------------ internals

  private async handle(request: unknown, mode: RestartMode): Promise<RestartResponse> {
    const nowMs = this.now()

    // Shape first: a malformed request must not reach the cooldown ledger or the
    // duplicate map, both of which are keyed by fields the shape check validates.
    const shape = validateShape(request)
    if (!shape.valid || shape.request === null) {
      return this.refuse(request, mode, shape.code ?? 'INVALID_REQUEST', shape.detail)
    }

    const normalized = shape.request
    const fingerprint = requestFingerprint({ ...normalized, mode: normalized.mode })

    const duplicate = this.seen.get(normalized.requestId)
    if (duplicate !== undefined && this.config.safety.duplicateSuppression) {
      return duplicate.fingerprint === fingerprint
        ? duplicate.response
        : {
            accepted: false,
            state: 'rejected',
            reason: 'DUPLICATE_REQUEST_ID',
            detail: `request id ${normalized.requestId} was already used for a different request`,
            requestId: normalized.requestId,
          }
    }

    const validation = validateRequest(
      { ...normalized, mode: normalized.mode },
      this.config,
      {
        nowMs,
        restartInFlight: !this.lock.idle,
        cooldowns: { application: this.cooldownUntil.application, system: this.cooldownUntil.system },
        isDuplicate: duplicate !== undefined,
        crashLoopTripped: this.safeMode().tripped,
        supervisorPresent: this.supervisorPresent(nowMs),
        checkpointPortAvailable: this.gate.available,
      },
    )
    if (!validation.valid || validation.request === null) {
      const response = this.refuse(
        normalized,
        normalized.mode,
        validation.code ?? 'INVALID_REQUEST',
        validation.detail,
      )
      this.remember(normalized.requestId, fingerprint, response, nowMs)
      return response
    }
    const accepted = validation.request

    const ticketId = `${accepted.mode}-${nowMs}-${this.audit.nextSequence()}-${randomUUID().slice(0, 8)}`

    const refusal = this.lock.transition('REQUESTED', accepted.requestId)
    if (refusal !== null) {
      const response = this.refuse(accepted, accepted.mode, 'RESTART_IN_FLIGHT', refusal.detail)
      this.remember(accepted.requestId, fingerprint, response, nowMs)
      return response
    }
    this.active = {
      normalized: accepted,
      ticketId,
      state: 'queued',
      createdAtMs: nowMs,
      updatedAtMs: nowMs,
      attempts: 0,
    }

    // 1. Checkpoint.
    this.lock.transition('CHECKPOINTING')
    this.setActiveState('checkpointing')
    const gate = await this.gate.prepare(accepted.mode, accepted.checkpointRequired)
    if (!gate.authorized) {
      const code = gate.outcome.reason === 'checkpoint_threw' || gate.outcome.reason === 'no_checkpoint_port'
        ? 'CHECKPOINT_FAILED'
        : gate.outcome.safe
          ? 'CHECKPOINT_FAILED'
          : 'CHECKPOINT_REQUIRED'
      const response = this.abort(
        accepted,
        ticketId,
        code,
        `restart aborted: ${gate.outcome.detail} (reason ${gate.outcome.reason})`,
      )
      this.remember(accepted.requestId, fingerprint, response, nowMs)
      return response
    }

    // 2. Ticket. Written only after the checkpoint gate has been passed, so a
    //    supervisor can never observe a ticket for a restart that was refused.
    try {
      this.store.writeTicket(
        buildTicket({
          ticketId,
          requestId: accepted.requestId,
          mode: accepted.mode,
          reasonCode: accepted.reasonCode,
          reasonSummary: accepted.reasonSummary,
          pid: this.pid,
          ttlMs: this.config.supervisor.ticketTtlMs,
          cleanShutdown: true,
          checkpointId: gate.outcome.checkpointId,
          nowMs,
        }),
      )
    } catch (error) {
      const response = this.abort(
        accepted,
        ticketId,
        'TICKET_WRITE_FAILED',
        `restart aborted: could not write the restart ticket (${(error as Error).message})`,
      )
      this.remember(accepted.requestId, fingerprint, response, nowMs)
      return response
    }

    // 3. The reboot itself, or the graceful shutdown that precedes a relaunch.
    //
    // A system restart does NOT ask the host to exit quietly: the host exiting is not
    // a reboot. It asks the machine's own restart port, and the ticket exists so the
    // supervisor knows what to expect when the machine comes back. Conflating the two
    // is how a "system reboot" silently degrades into "the app closed".
    if (accepted.mode === 'system') {
      this.lock.transition('SHUTTING_DOWN')
      this.setActiveState('shutting_down')
      const reboot = await this.performSystemReboot(ticketId)
      if (!reboot.applied) {
        this.store.clearTicket()
        const response = this.abort(accepted, ticketId, 'SYSTEM_REBOOT_FAILED', reboot.detail)
        this.remember(accepted.requestId, fingerprint, response, nowMs)
        return response
      }
      this.cooldownUntil[accepted.mode] = nowMs + this.modeConfig(accepted.mode).minIntervalMs
      this.active = { ...(this.active as ActiveRequest), attempts: 1, updatedAtMs: nowMs }
      const response: RestartResponse = {
        accepted: true,
        state: 'shutting_down',
        detail: 'system restart accepted: the machine will reboot and the supervisor will relaunch DS-Hns',
        requestId: accepted.requestId,
        ticketId,
      }
      this.record({
        requestId: accepted.requestId,
        ticketId,
        mode: accepted.mode,
        source: accepted.source,
        reasonCode: accepted.reasonCode,
        state: 'shutting_down',
        startedAtMs: nowMs,
        detail: `${response.detail} (checkpoint ${gate.outcome.checkpointId ?? 'none'}, reason ${accepted.reasonCode})`,
        clean: true,
        outcomeCode: 'ACCEPTED',
      })
      this.remember(accepted.requestId, fingerprint, response, nowMs)
      return response
    }

    // 4. Graceful shutdown of the application.
    this.lock.transition('SHUTTING_DOWN')
    this.setActiveState('shutting_down')
    let shutdownAccepted = false
    try {
      shutdownAccepted = await this.ports.shutdown.requestShutdown(ticketId)
    } catch (error) {
      const response = this.abort(
        accepted,
        ticketId,
        'SHUTDOWN_PORT_UNAVAILABLE',
        `restart aborted: the shutdown request threw (${(error as Error).message})`,
      )
      this.remember(accepted.requestId, fingerprint, response, nowMs)
      return response
    }
    if (!shutdownAccepted) {
      const response = this.abort(
        accepted,
        ticketId,
        'SHUTDOWN_PORT_UNAVAILABLE',
        'restart aborted: the host refused the graceful shutdown request',
      )
      this.remember(accepted.requestId, fingerprint, response, nowMs)
      return response
    }

    // 5. The process is expected to exit now. Nothing further is awaited: awaiting
    //    our own exit is how a restart service deadlocks itself.
    this.cooldownUntil[accepted.mode] = nowMs + this.modeConfig(accepted.mode).minIntervalMs
    this.active = { ...(this.active as ActiveRequest), attempts: 1, updatedAtMs: nowMs }

    const response: RestartResponse = {
      accepted: true,
      state: 'shutting_down',
      detail: 'application restart accepted: the host is shutting down and the supervisor will relaunch it',
      requestId: accepted.requestId,
      ticketId,
    }
    // The audit record is written before the response is returned, so an operator
    // reading the log always sees why the process is about to disappear.
    this.record({
      requestId: accepted.requestId,
      ticketId,
      mode: accepted.mode,
      source: accepted.source,
      reasonCode: accepted.reasonCode,
      state: 'shutting_down',
      startedAtMs: nowMs,
      detail: `${response.detail} (checkpoint ${gate.outcome.checkpointId ?? 'none'}, reason ${accepted.reasonCode})`,
      clean: true,
      outcomeCode: 'ACCEPTED',
    })
    this.remember(accepted.requestId, fingerprint, response, nowMs)
    return response
  }

  /** Build a refusal response and log it. */
  private refuse(request: unknown, mode: RestartMode, code: string, detail: string): RestartResponse {
    const requestId =
      typeof request === 'object' && request !== null && typeof (request as RestartRequest).requestId === 'string'
        ? (request as RestartRequest).requestId
        : 'unknown'
    const source =
      typeof request === 'object' && request !== null && typeof (request as RestartRequest).source === 'string'
        ? (request as RestartRequest).source
        : 'unknown'
    const reasonCode =
      typeof request === 'object' && request !== null && typeof (request as RestartRequest).reasonCode === 'string'
        ? (request as RestartRequest).reasonCode
        : 'unspecified'
    this.audit.append({
      requestId,
      ticketId: null,
      mode,
      source,
      reasonCode,
      state: 'rejected',
      startedAt: new Date(this.now()).toISOString(),
      finishedAt: new Date(this.now()).toISOString(),
      detail,
      clean: true,
      outcomeCode: code,
    })
    this.emitLast()
    return { accepted: false, state: 'rejected', reason: code, detail, requestId }
  }

  /** Abort an in-flight request, releasing the lock and clearing the ticket. */
  private abort(
    request: { readonly requestId: string; readonly source: string; readonly reasonCode: string; readonly mode: RestartMode },
    ticketId: string,
    code: string,
    detail: string,
  ): RestartResponse {
    this.store.clearTicket()
    this.lock.release(code)
    const startedAtMs = this.active?.createdAtMs ?? this.now()
    this.record({
      requestId: request.requestId,
      ticketId,
      mode: request.mode,
      source: request.source,
      reasonCode: request.reasonCode,
      state: 'failed',
      startedAtMs,
      detail,
      clean: true,
      outcomeCode: code,
    })
    this.active = null
    return { accepted: false, state: 'failed', reason: code, detail, requestId: request.requestId, ticketId }
  }

  private setActiveState(state: RestartRequestState): void {
    if (this.active === null) return
    this.active = { ...this.active, state, updatedAtMs: this.now() }
  }

  /**
   * Perform a system reboot through the system-shutdown port.
   *
   * A reboot is the one action in this repository that can end unrelated work on the
   * machine, so it is reached only through a dedicated port that a deployment can
   * leave unbound. Without it, a `mode: "system"` request is refused rather than
   * quietly downgraded to an application restart: answering "accepted" to something
   * that will not happen is the worst available outcome.
   */
  private async performSystemReboot(ticketId: string): Promise<{ readonly applied: boolean; readonly detail: string }> {
    const port = this.ports.systemShutdown
    if (port === null) {
      return {
        applied: false,
        detail:
          'restart aborted: no system-shutdown port is bound on this machine, so a reboot cannot be performed. ' +
          'Request an application restart instead, or bind the port.',
      }
    }
    try {
      const accepted = await port.requestSystemRestart(ticketId, SYSTEM_REBOOT_DELAY_SECONDS)
      return accepted
        ? { applied: true, detail: `the machine will restart in ${SYSTEM_REBOOT_DELAY_SECONDS}s (ticket ${ticketId})` }
        : { applied: false, detail: 'restart aborted: the system-shutdown port refused the reboot request' }
    } catch (error) {
      return { applied: false, detail: `restart aborted: the reboot request threw (${(error as Error).message})` }
    }
  }

  private remember(requestId: string, fingerprint: string, response: RestartResponse, atMs: number): void {
    this.seen.set(requestId, { fingerprint, response, atMs })
    // Bounded: the duplicate ledger only needs to cover a restart's worth of
    // retries, not the process's whole lifetime.
    if (this.seen.size > 200) {
      const oldest = [...this.seen.entries()].sort((a, b) => a[1].atMs - b[1].atMs)[0]
      if (oldest !== undefined) this.seen.delete(oldest[0])
    }
  }

  private record(input: {
    requestId: string
    ticketId: string | null
    mode: RestartMode
    source: string
    reasonCode: string
    state: RestartRequestState
    startedAtMs: number
    detail: string
    clean: boolean
    outcomeCode: string
  }): RestartAttemptRecord {
    const record: RestartAttemptRecord = {
      requestId: input.requestId,
      ticketId: input.ticketId,
      mode: input.mode,
      source: input.source,
      reasonCode: input.reasonCode,
      state: input.state,
      startedAt: new Date(input.startedAtMs).toISOString(),
      finishedAt: new Date(this.now()).toISOString(),
      detail: input.detail,
      clean: input.clean,
      outcomeCode: input.outcomeCode,
    }
    this.audit.append(record)
    this.emitLast()
    return record
  }

  private emitLast(): void {
    if (this.onAttempt === null) return
    const [latest] = this.audit.recent(1)
    if (latest !== undefined) this.onAttempt(latest)
  }

  private modeConfig(mode: RestartMode): { readonly enabled: boolean; readonly minIntervalMs: number } {
    return mode === 'system' ? this.config.systemRestart : this.config.applicationRestart
  }

  private cooldownView(mode: RestartMode, nowMs: number): CooldownState {
    const until = this.cooldownUntil[mode]
    return {
      nextAllowedAt: until > nowMs ? new Date(until).toISOString() : null,
      remainingMs: Math.max(0, until - nowMs),
      minimumIntervalMs: this.modeConfig(mode).minIntervalMs,
    }
  }

  private activeView(): RestartActiveRequest | null {
    const active = this.active
    if (active === null) return null
    const normalized = active.normalized as unknown as {
      readonly requestId: string
      readonly source: string
      readonly mode: RestartMode
      readonly reasonCode: string
      readonly priority: RestartActiveRequest['priority']
    }
    return {
      requestId: normalized.requestId,
      ticketId: active.ticketId,
      source: normalized.source,
      mode: normalized.mode,
      reasonCode: normalized.reasonCode,
      priority: normalized.priority,
      state: active.state,
      createdAt: new Date(active.createdAtMs).toISOString(),
      updatedAt: new Date(active.updatedAtMs).toISOString(),
      attempts: active.attempts,
    }
  }

  private crashLoopView(): CrashLoopState {
    const safeMode = this.safeMode()
    return {
      tripped: safeMode.tripped,
      failuresInWindow: safeMode.tripped ? this.config.safety.crashLoopLimit : 0,
      limit: this.config.safety.crashLoopLimit,
      windowMs: this.config.safety.crashLoopWindowMs,
      trippedAt: safeMode.atMs === null ? null : new Date(safeMode.atMs).toISOString(),
      reason: safeMode.reason,
    }
  }

  /**
   * Whether automatic restart is currently disabled, from either source.
   *
   * Two independent things can disable it: this process can be told to (an operator,
   * or the plugin's own observation), and the **supervisor's durable ledger** can say
   * so after its crash-loop breaker tripped. The ledger matters because the supervisor
   * is a different process and outlives a restart: without reading it, a crash loop
   * would be invisible to the very plugin that keeps asking for restarts.
   */
  private safeMode(): { readonly tripped: boolean; readonly reason: string | null; readonly atMs: number | null } {
    if (this.crashLoopTripped) {
      return { tripped: true, reason: this.crashLoopReason, atMs: this.crashLoopTrippedAtMs }
    }
    const ledger = this.store.readLedger()
    if (ledger.safeMode) {
      const at = ledger.safeModeAt === null ? Number.NaN : Date.parse(ledger.safeModeAt)
      return {
        tripped: true,
        reason: ledger.safeModeReason === null ? 'supervisor_safe_mode' : `supervisor: ${ledger.safeModeReason}`,
        atMs: Number.isFinite(at) ? at : null,
      }
    }
    return { tripped: false, reason: null, atMs: null }
  }

  /** Whether the supervisor's ledger currently reports safe mode. */
  get supervisorSafeMode(): boolean {
    return this.store.readLedger().safeMode
  }

  /**
   * Whether the health scheduler should consider this manager usable.
   *
   * Derived rather than asserted: a manager whose configuration disables every restart
   * mode can accept a request but can never carry one out, so reporting `available`
   * would make the health scheduler raise requests that are guaranteed to be refused.
   * `unavailable` makes it downgrade its own decision and say why, which is the honest
   * outcome and the one an operator can act on.
   */
  get capabilityForHealthScheduler(): 'available' | 'unavailable' | 'failed' {
    if (!this.config.enabled) return 'unavailable'
    const anyMode =
      this.config.applicationRestart.enabled ||
      (this.config.systemRestart.enabled && this.config.allowSystemReboot && this.ports.systemShutdown !== null)
    return anyMode ? 'available' : 'unavailable'
  }

  private supervisorView(nowMs: number): SupervisorPresence {
    const heartbeat = this.store.readHeartbeat()
    const age = this.store.heartbeatAgeMs(nowMs)
    const present = age !== null && age <= this.config.supervisor.heartbeatTimeoutMs
    return {
      present,
      lastSeenAt: heartbeat === null ? null : heartbeat.timestamp,
      ageMs: age,
    }
  }

  private supervisorPresent(nowMs: number): boolean {
    return this.supervisorView(nowMs).present
  }

  private canRestart(nowMs: number): { readonly allowed: boolean; readonly reason: string } {
    if (!this.config.enabled) return { allowed: false, reason: 'DISABLED' }
    if (this.safeMode().tripped) return { allowed: false, reason: 'CRASH_LOOP' }
    if (!this.lock.idle) return { allowed: false, reason: 'RESTART_IN_FLIGHT' }
    if (!this.config.applicationRestart.enabled) return { allowed: false, reason: 'MODE_NOT_ALLOWED' }
    if (this.cooldownUntil.application > nowMs) return { allowed: false, reason: 'COOLDOWN_ACTIVE' }
    if (!this.supervisorPresent(nowMs) && !this.config.safety.allowRestartWithoutSupervisor) {
      return { allowed: false, reason: 'SUPERVISOR_ABSENT' }
    }
    if (!this.gate.available && this.config.safety.checkpointRequired) {
      return { allowed: false, reason: 'CHECKPOINT_FAILED' }
    }
    return { allowed: true, reason: 'OK' }
  }

  /** Lock state, for diagnostics and tests. */
  get lockState(): RestartLockState {
    return this.lock.state
  }
}
