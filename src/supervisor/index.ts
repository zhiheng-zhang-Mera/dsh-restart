/**
 * The supervisor.
 *
 * ```
 * MONITORING -> (valid ticket) -> WAITING_FOR_EXIT -> RELAUNCHING
 *            -> WAITING_FOR_HEARTBEAT -> VERIFIED -> MONITORING
 *            -> (repeated failure) -> CRASH_LOOP -> SAFE_MODE
 * ```
 *
 * It is intentionally the smallest thing that can own a process lifecycle: watch a
 * pid, read a ticket, wait for the exit, relaunch, verify a heartbeat, and give up
 * loudly if that keeps failing. It has no idea what DS-Hns does, no access to task
 * state, and no concept of health.
 *
 * @module dsh-restart/supervisor
 */

import { TicketStore, emptyLedger } from '../plugin/ticket-store.js'
import type { RestartConfig } from '../shared/types.js'
import type { RestartTicket, SupervisorState } from '../shared/protocol.js'
import { CrashLoopBreaker } from './crash-loop-breaker.js'
import { HeartbeatWriter } from './heartbeat.js'
import { SystemLivenessProbe, type LivenessProbe } from './pid-watch.js'
import {
  ChildProcessLauncher,
  deriveLaunchSpec,
  type LaunchSpec,
  type ProcessLauncher,
  type ProcessTerminator,
} from './relaunch.js'

/** One line in the supervisor's own log. */
export interface SupervisorEvent {
  readonly timestamp: string
  readonly state: SupervisorState
  readonly message: string
  /** Machine-readable code, so an operator can grep. */
  readonly code: string
  /** Extra detail, safe to log. */
  readonly detail?: Readonly<Record<string, unknown>>
}

/** Options for {@link RestartSupervisor}. */
export interface RestartSupervisorOptions {
  readonly config: RestartConfig
  /** Directory holding the ticket, heartbeat and ledger. */
  readonly directory: string
  /** Pid to watch. Defaults to `process.ppid` — the process that started the supervisor. */
  readonly watchPid?: number
  /** Order to terminate the supervisor after a successful verify. */
  readonly terminateAfterVerify?: boolean
  /** Observer for the supervisor log. */
  readonly onEvent?: (event: SupervisorEvent) => void
  /** Injectable clock. */
  readonly now?: () => number
  /** Injectable liveness probe. */
  readonly probe?: LivenessProbe
  /** Injectable process launcher. */
  readonly launcher?: ProcessLauncher
  /**
   * Terminates a process that ignored its graceful shutdown.
   *
   * Only consulted when `safety.allowForceTerminate` is on, and `null` by default:
   * a supervisor that can kill on its own is a supervisor that can kill by mistake.
   */
  readonly terminator?: ProcessTerminator | null
  /**
   * Called once a relaunch has been observed alive, so the harness can acknowledge
   * that a checkpoint was consumed. Failures are contained.
   */
  readonly onResume?: (info: { readonly pid: number; readonly reason: string }) => void | Promise<void>
  /** `argv` used when `supervisor.launchCommand` is unset. Defaults to this process's argv. */
  readonly argv?: readonly string[]
  /** Working directory used when `supervisor.launchCwd` is unset. Defaults to `process.cwd()`. */
  readonly cwd?: string
}

/** How a supervisor run ended. */
export interface SupervisorRunResult {
  readonly state: SupervisorState
  readonly reason: string
  readonly relaunches: number
  readonly safeMode: boolean
}

/** The supervisor itself. */
export class RestartSupervisor {
  private readonly config: RestartConfig
  private readonly store: TicketStore
  private readonly probe: LivenessProbe
  private readonly launcher: ProcessLauncher
  private readonly now: () => number
  private readonly events: SupervisorEvent[] = []
  private readonly onEvent: ((event: SupervisorEvent) => void) | null
  private readonly breaker: CrashLoopBreaker
  private readonly heartbeat: HeartbeatWriter
  private readonly argv: readonly string[]
  private readonly cwd: string
  private readonly terminateAfterVerify: boolean
  private readonly terminator: ProcessTerminator | null
  private readonly onResume: ((info: { readonly pid: number; readonly reason: string }) => void | Promise<void>) | null
  private lastRelaunchAt: number | null = null
  private consecutiveRelaunchFailures = 0

  private watchedPid: number
  private state: SupervisorState = 'MONITORING'
  private relaunches = 0
  private running = false
  private verified = false
  private lastLaunch: LaunchSpec | null = null
  private readonly maxEvents = 500

  constructor(options: RestartSupervisorOptions) {
    this.config = options.config
    this.store = new TicketStore(options.directory)
    this.probe = options.probe ?? new SystemLivenessProbe()
    this.launcher = options.launcher ?? new ChildProcessLauncher()
    this.now = options.now ?? (() => Date.now())
    this.onEvent = options.onEvent ?? null
    this.argv = options.argv ?? process.argv.slice(1)
    this.cwd = options.cwd ?? process.cwd()
    this.terminateAfterVerify = options.terminateAfterVerify === true
    this.terminator = options.terminator ?? null
    this.onResume = options.onResume ?? null
    this.watchedPid = options.watchPid ?? process.ppid
    this.stateSinceMs = this.now()
    this.breaker = new CrashLoopBreaker({ config: this.config.safety, ledger: this.store.readLedger() })
    this.heartbeat = new HeartbeatWriter({
      store: this.store,
      config: this.config.supervisor,
      supervisorPid: process.pid,
      watchedPid: this.watchedPid,
      now: this.now,
    })
  }

  /** Current state. */
  get currentState(): SupervisorState {
    return this.state
  }

  /** Pid the supervisor is watching. */
  get pid(): number {
    return this.watchedPid
  }

  /** The log so far, oldest first. */
  get log(): readonly SupervisorEvent[] {
    return [...this.events]
  }

  /** Whether a relaunch has been observed alive at least once in this run. */
  get hasVerifiedRelaunch(): boolean {
    return this.verified
  }

  /** Run one supervision step. Exposed so a test can drive the machine without timers. */
  async tick(): Promise<SupervisorRunResult> {
    const nowMs = this.now()

    // Safe mode short-circuits everything: once the breaker has tripped, the
    // supervisor stops relaunching and simply reports. Regaining automation is an
    // explicit act (clearing the ledger), never something the supervisor does by
    // itself after "enough time has passed".
    if (this.breaker.isTripped) {
      if (this.state !== 'SAFE_MODE') {
        this.setState('SAFE_MODE', 'crash_loop_breaker_tripped', {
          reason: this.breaker.tripReason ?? 'unknown',
        })
      }
      return this.result('SAFE_MODE', 'CRASH_LOOP')
    }

    const verification = this.store.readTicket(nowMs)

    // A ticket that exists but does not verify is a hazard, not a hint: delete it
    // and keep monitoring rather than acting on a doubtful document.
    if (this.store.hasTicket() && !verification.valid) {
      this.store.clearTicket()
      this.emit('MONITORING', 'discarded_unverifiable_ticket', verification.detail, {
        rejection: verification.rejection ?? 'unknown',
      })
    }

    const ticket = verification.valid ? verification.ticket : null
    if (ticket !== null && ticket.pid !== this.watchedPid) {
      // The ticket names a different process than the one being watched. Honour the
      // ticket: it is the fresher statement of intent.
      this.watchedPid = ticket.pid
      this.heartbeat.watch(ticket.pid)
      this.emit('MONITORING', 'adopted_ticket_pid', `now watching pid ${ticket.pid} from ticket ${ticket.ticketId}`)
    }

    const liveness = await this.probe.check(this.watchedPid)
    const alive = liveness.alive

    if (ticket !== null && this.state === 'MONITORING') {
      this.setState('WAITING_FOR_EXIT', 'restart_ticket_accepted', {
        ticketId: ticket.ticketId,
        mode: ticket.mode,
        pid: this.watchedPid,
      })
    }
    if (this.state === 'WAITING_FOR_EXIT') {
      if (alive === null) {
        this.emit('WAITING_FOR_EXIT', 'liveness_probe_failed', liveness.detail)
        return this.result('WAITING_FOR_EXIT', 'PROBE_FAILED')
      }
      if (alive) {
        // The host was asked to exit and has not. That is not a reason to wait
        // forever: a shutdown that never lands is exactly the failure mode the
        // design's case 4 describes, and the answer is a bounded wait followed by a
        // recorded decision rather than an indefinite one.
        const waited = nowMs - this.stateSinceMs
        if (waited >= this.config.safety.shutdownTimeoutMs) {
          return this.onShutdownTimeout(ticket, waited)
        }
        return this.result('WAITING_FOR_EXIT', 'WAITING')
      }
      this.store.clearTicket()
      return this.relaunch('expected_exit_observed')
    }

    if (this.state === 'WAITING_FOR_HEARTBEAT') {
      if (alive === true) {
        this.verified = true
        this.setState('VERIFIED', 'relaunch_verified', { pid: this.watchedPid })
        // The harness asked to be told when a checkpoint is consumed. Telling it is
        // the last step of the restart, and a failure here must not be mistaken for
        // a failure of the restart itself.
        if (this.onResume !== null) {
          try {
            await this.onResume({ pid: this.watchedPid, reason: 'relaunch_verified' })
          } catch (error) {
            this.emit('VERIFIED', 'resume_acknowledgement_failed', (error as Error).message)
          }
        }
        this.setState('MONITORING', 'monitoring_resumed', { pid: this.watchedPid })
        return this.result('MONITORING', 'VERIFIED')
      }
      if (this.now() - this.stateEnteredAtMs() >= this.config.supervisor.relaunchTimeoutMs) {
        const verdict = this.breaker.recordUncleanStart('no_liveness_after_relaunch', nowMs)
        this.emit('WAITING_FOR_HEARTBEAT', 'relaunch_verification_failed', 'the relaunched process is not alive', {
          failuresInWindow: verdict.failuresInWindow,
          limit: verdict.limit,
        })
        if (!verdict.allowed && this.config.safety.safeModeOnLoop) {
          this.setState('CRASH_LOOP', 'crash_loop_limit_reached', { failuresInWindow: verdict.failuresInWindow })
          if (this.config.safety.safeModeOnLoop) {
            await this.enterSafeMode()
          }
          return this.result('SAFE_MODE', 'CRASH_LOOP')
        }
        return this.relaunch('relaunch_retry')
      }
      return this.result('WAITING_FOR_HEARTBEAT', 'WAITING')
    }

    if (this.state === 'RELAUNCHING') {
      return this.relaunch('resuming_relaunch')
    }

    // MONITORING: if the process has died without a ticket, that is a crash. Note
    // it, and relaunch — bounded by the breaker.
    if (alive === false) {
      const verdict = this.breaker.recordUncleanStart('process_died_without_ticket', nowMs)
      this.emit('MONITORING', 'process_died_without_ticket', `pid ${this.watchedPid} is gone`, {
        failuresInWindow: verdict.failuresInWindow,
        limit: verdict.limit,
      })
      if (!verdict.allowed) {
        this.setState('CRASH_LOOP', 'crash_loop_limit_reached', { failuresInWindow: verdict.failuresInWindow })
        if (this.config.safety.safeModeOnLoop) await this.enterSafeMode()
        return this.result('SAFE_MODE', 'CRASH_LOOP')
      }
      return this.relaunch('unexpected_exit')
    }

    return this.result('MONITORING', alive === true ? 'MONITORING' : 'UNKNOWN')
  }

  /**
   * Run until the supervisor decides it is done.
   *
   * @param options - `maxTicks` and `tickMs` bound the run; `stopWhen` can end it
   *   early. A test passes `maxTicks`; production passes neither and stops when the
   *   result is terminal.
   */
  async run(options: { readonly tickMs?: number; readonly maxTicks?: number } = {}): Promise<SupervisorRunResult> {
    const tickMs = options.tickMs ?? this.config.supervisor.pollIntervalMs
    const maxTicks = options.maxTicks ?? Number.POSITIVE_INFINITY
    this.running = true
    this.heartbeat.start()
    this.emit('MONITORING', 'supervisor_started', `watching pid ${this.watchedPid}`, {
      supervisorPid: process.pid,
      directory: this.store.paths.directory,
    })
    try {
      for (let tick = 0; tick < maxTicks; tick += 1) {
        const result = await this.tick()
        if (result.reason === 'VERIFIED' || result.reason === 'CRASH_LOOP') {
          if (result.reason === 'VERIFIED' && this.terminateAfterVerify) return result
          if (result.reason === 'CRASH_LOOP') return result
        }
        await delay(tickMs)
      }
      return this.result(this.state, 'TICK_LIMIT')
    } finally {
      this.running = false
      this.heartbeat.stop()
    }
  }

  /** Whether {@link run} is active. */
  get isRunning(): boolean {
    return this.running
  }

  /** Stop the run loop after the current tick. */
  stop(): void {
    this.running = false
    this.heartbeat.stop()
  }

  /** Persist the breaker's state and the relaunch count. */
  persistLedger(): void {
    this.store.writeLedger({
      ...emptyLedger(),
      ...this.breaker.toLedgerFields(),
      relaunches: this.relaunches,
    })
  }

  /**
   * Decide what to do when the host ignored its own graceful shutdown.
   *
   * Three outcomes, in order of preference:
   *
   * 1. `allowForceTerminate` is on and a terminator is bound: terminate, record the
   *    restart as dirty, and relaunch.
   * 2. `allowForceTerminate` is on but nothing can terminate: say so and keep waiting,
   *    because a supervisor has no business inventing a kill.
   * 3. The default: abandon the restart, clear the ticket, and report it. The
   *    process keeps running with its ticket gone, which is the safe reading —
   *    "the restart did not happen" rather than "something was killed to make it
   *    happen".
   */
  private async onShutdownTimeout(ticket: RestartTicket | null, waitedMs: number): Promise<SupervisorRunResult> {
    const ticketId = ticket?.requestId ?? 'unknown'
    if (!this.config.safety.allowForceTerminate) {
      this.store.clearTicket()
      this.recordUnclean('shutdown_timeout_no_force', {
        ticketId,
        waitedMs,
        forceTerminate: false,
      })
      this.setState('MONITORING', 'shutdown_abandoned', { ticketId, waitedMs })
      return this.result('MONITORING', 'SHUTDOWN_ABANDONED')
    }

    if (this.terminator === null) {
      this.emit('WAITING_FOR_EXIT', 'no_terminator_bound', 'allowForceTerminate is on but no terminator is bound', {
        ticketId,
        waitedMs,
      })
      return this.result('WAITING_FOR_EXIT', 'NO_TERMINATOR')
    }

    const terminated = await this.terminator.terminate(this.watchedPid)
    this.store.clearTicket()
    this.recordUnclean('shutdown_timeout_force_terminated', {
      ticketId,
      waitedMs,
      forceTerminate: true,
      terminated: terminated.ok,
      detail: terminated.detail,
    })
    if (!terminated.ok) {
      return this.result('WAITING_FOR_EXIT', 'TERMINATE_FAILED')
    }
    // The exit path is now the ordinary one, but the restart is recorded as dirty
    // because a process that had to be killed did not reach a safe point.
    return this.relaunch('dirty_restart_after_force_terminate')
  }

  /**
   * Record an unclean start and feed the outcome to the breaker.
   *
   * @returns the verdict for the next relaunch.
   */
  private recordUnclean(
    reason: string,
    detail: Readonly<Record<string, unknown>>,
  ): ReturnType<CrashLoopBreaker['recordUncleanStart']> {
    const verdict = this.breaker.recordUncleanStart(reason, this.now())
    this.persistLedger()
    this.emit(this.state, reason, reason, { ...detail, failuresInWindow: verdict.failuresInWindow })
    return verdict
  }

  private async relaunch(reason: string): Promise<SupervisorRunResult> {
    // Pace successive attempts. A relaunch that fails once usually fails again
    // immediately, and a supervisor that retries on every poll tick is
    // indistinguishable from a fork bomb.
    if (this.lastRelaunchAt !== null) {
      const since = this.now() - this.lastRelaunchAt
      const backoff = this.relaunchBackoffMs()
      if (since < backoff) {
        this.emit('RELAUNCHING', 'relaunch_backoff', 'waiting before the next relaunch attempt', {
          sinceMs: since,
          backoffMs: backoff,
          consecutiveFailures: this.consecutiveRelaunchFailures,
        })
        return this.result('RELAUNCHING', 'BACKOFF')
      }
    }

    this.setState('RELAUNCHING', 'relaunching', { reason })

    const verdict = this.breaker.verdict(this.now())
    if (!verdict.allowed) {
      this.setState('CRASH_LOOP', 'crash_loop_limit_reached', { failuresInWindow: verdict.failuresInWindow })
      if (this.config.safety.safeModeOnLoop) await this.enterSafeMode()
      return this.result('SAFE_MODE', 'CRASH_LOOP')
    }

    const spec = deriveLaunchSpec({
      config: this.config.supervisor,
      supervisorArgv: this.argv,
      supervisorCwd: this.cwd,
    })
    if (spec === null) {
      this.emit('RELAUNCHING', 'no_launch_command', 'cannot relaunch: no launch command could be derived')
      this.setState('SAFE_MODE', 'safe_mode_no_launch_command', {})
      return this.result('SAFE_MODE', 'NO_LAUNCH_COMMAND')
    }
    this.lastLaunch = spec

    const launched = await this.launcher.launch(spec)
    this.lastRelaunchAt = this.now()
    if (!launched.ok || launched.pid <= 0) {
      this.consecutiveRelaunchFailures += 1
      const unclean = this.breaker.recordUncleanStart('relaunch_failed', this.now())
      this.emit('RELAUNCHING', 'relaunch_failed', launched.detail, {
        failuresInWindow: unclean.failuresInWindow,
        consecutiveFailures: this.consecutiveRelaunchFailures,
      })
      this.persistLedger()
      if (!unclean.allowed) {
        this.setState('CRASH_LOOP', 'crash_loop_limit_reached', { failuresInWindow: unclean.failuresInWindow })
        if (this.config.safety.safeModeOnLoop) await this.enterSafeMode()
        return this.result('SAFE_MODE', 'CRASH_LOOP')
      }
      return this.result('RELAUNCHING', 'RELAUNCH_FAILED')
    }

    this.relaunches += 1
    this.consecutiveRelaunchFailures = 0
    this.watchedPid = launched.pid
    this.heartbeat.watch(launched.pid)
    this.persistLedger()
    this.setState('WAITING_FOR_HEARTBEAT', 'relaunched', { pid: launched.pid })
    return this.result('WAITING_FOR_HEARTBEAT', 'RELAUNCHED')
  }

  private async enterSafeMode(): Promise<void> {
    this.setState('SAFE_MODE', 'safe_mode_entered', {
      reason: this.breaker.tripReason ?? 'unknown',
      relaunches: this.relaunches,
    })
    this.persistLedger()
    this.emit(
      'SAFE_MODE',
      'safe_mode_manual_action_required',
      'automation is disabled; DS-Hns still runs. Fix the underlying problem, then delete the safeMode flag in ledger.json (or run scripts/enable.ps1) to restore automatic restart.',
    )
  }

  private setState(state: SupervisorState, code: string, detail: Readonly<Record<string, unknown>>): void {
    // Entering the state you are already in is not a transition, and must not reset
    // the deadline that state is waiting on — otherwise a wait that should expire
    // gets a fresh budget on every poll and never does.
    if (state === this.state) {
      this.heartbeat.setState(state)
      return
    }
    this.state = state
    this.stateSinceMs = this.now()
    this.heartbeat.setState(state)
    this.emit(state, code, code, detail)
  }

  /**
   * When the current state was entered.
   *
   * Seeded in the constructor with the clock rather than left at zero: a supervisor
   * built with an injectable clock that starts at a fixed epoch would otherwise
   * measure its very first wait from that epoch, and every deadline would look long
   * expired before the first tick.
   */
  private stateSinceMs = 0

  private stateEnteredAtMs(): number {
    return this.stateSinceMs
  }


  private emit(
    state: SupervisorState,
    code: string,
    message: string,
    detail?: Readonly<Record<string, unknown>>,
  ): void {
    const event: SupervisorEvent = {
      timestamp: new Date(this.now()).toISOString(),
      state,
      code,
      message,
      ...(detail === undefined ? {} : { detail }),
    }
    this.events.push(event)
    if (this.events.length > this.maxEvents) this.events.shift()
    try {
      this.onEvent?.(event)
    } catch {
      // A log observer must never break supervision.
    }
  }

  private result(state: SupervisorState, reason: string): SupervisorRunResult {
    return { state, reason, relaunches: this.relaunches, safeMode: this.breaker.isTripped }
  }

  /** The last launch specification used, or `null`. */
  get lastLaunchSpec(): LaunchSpec | null {
    return this.lastLaunch
  }

  /** The pending ticket, or `null`. */
  pendingTicket(): RestartTicket | null {
    return this.store.readTicket(this.now()).ticket
  }

  /** Current relaunch backoff, doubling per consecutive failure up to the ceiling. */
  private relaunchBackoffMs(): number {
    const base = this.config.supervisor.relaunchBackoffMs
    if (base <= 0) return 0
    // Capped at six doublings so the exponent cannot run away on a long incident.
    const steps = Math.min(this.consecutiveRelaunchFailures, 6)
    return Math.min(base * 2 ** steps, this.config.supervisor.relaunchBackoffMaxMs)
  }

  /** Consecutive failed relaunch attempts, reset by a successful launch. */
  get consecutiveFailures(): number {
    return this.consecutiveRelaunchFailures
  }
}

/** Resolve after `ms`, unref'd so it cannot hold the event loop open. */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms)
    timer.unref?.()
  })
}
