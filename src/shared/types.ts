/**
 * Configuration surface of `dsh-restart`.
 *
 * Every value here is a bound the plugin enforces on itself, not a policy about
 * *when* to restart. The plugin has no opinion about timing: it is told to restart
 * and it either can, safely, or it refuses and says why.
 *
 * @module dsh-restart/types
 */

import type { RestartMode, RestartPriority } from './protocol.js'

/** Configuration for one restart mode. */
export interface ModeConfig {
  /** Whether this mode may be used at all. */
  readonly enabled: boolean
  /** Enforced lower bound between two restarts of this mode, in milliseconds. */
  readonly minIntervalMs: number
}

/** Checkpoint and duplicate-suppression rules. */
export interface SafetyConfig {
  /** Whether a request that asks for a checkpoint must get one. */
  readonly checkpointRequired: boolean
  /** Whether a repeated `requestId` returns the previous answer instead of acting. */
  readonly duplicateSuppression: boolean
  /** Unclean starts inside the window that trip the breaker. */
  readonly crashLoopLimit: number
  /** Breaker window, in milliseconds. */
  readonly crashLoopWindowMs: number
  /** Whether tripping the breaker launches safe mode. */
  readonly safeModeOnLoop: boolean
  /** Milliseconds the process gets to exit after a graceful shutdown request. */
  readonly shutdownTimeoutMs: number
  /** Whether a timed-out shutdown may be terminated by the supervisor. */
  readonly allowForceTerminate: boolean
  /**
   * Whether a restart may be attempted when no supervisor heartbeat has been seen.
   *
   * Defaults to `false`: without a supervisor, exiting the process is not a
   * restart, it is a shutdown, and an unhealthy app that never comes back is worse
   * than an unhealthy app that is still running.
   */
  readonly allowRestartWithoutSupervisor: boolean
}

/** Supervisor timing and wiring. */
export interface SupervisorConfig {
  /** Milliseconds between supervisor heartbeats. */
  readonly heartbeatIntervalMs: number
  /** Heartbeat age after which the supervisor counts as absent. */
  readonly heartbeatTimeoutMs: number
  /** Milliseconds the supervisor waits for a relaunch to produce a heartbeat. */
  readonly relaunchTimeoutMs: number
  /** Executable the supervisor runs to relaunch DS-Hns. `null` means "reuse argv". */
  readonly launchCommand: readonly string[] | null
  /** Extra arguments appended to the relaunch command. */
  readonly launchArgs: readonly string[]
  /** Working directory for the relaunch, or `null` for the supervisor's own. */
  readonly launchCwd: string | null
  /** Milliseconds between PID polls while waiting for the exit. */
  readonly pollIntervalMs: number
  /** Milliseconds a pending ticket stays valid before the supervisor voids it. */
  readonly ticketTtlMs: number
  /** Run the supervisor detached from the plugin process. */
  readonly detach: boolean
}

/** Where durable state lives. */
export interface StorageConfig {
  /** Directory override; defaults to `<DSH_HOME>/restart`. */
  readonly directory: string | null
  /** Maximum bytes of the append-only audit log before it rotates. */
  readonly maxLogBytes: number
  /** How many attempts to keep in memory for the status call. */
  readonly maxRecentAttempts: number
}

/** The complete plugin configuration. */
export interface RestartConfig {
  /** Master switch. When false every request is refused with `DISABLED`. */
  readonly enabled: boolean
  readonly applicationRestart: ModeConfig
  readonly systemRestart: ModeConfig
  /**
   * Sources allowed to submit requests. A request from any other source is
   * refused, because "something on this machine asked me to reboot it" is not a
   * sufficient authorization.
   */
  readonly allowedSources: readonly string[]
  /** Priorities accepted at all. */
  readonly allowedPriorities: readonly RestartPriority[]
  /** Whether `mode: "system"` may ever be used, on top of its own `enabled`. */
  readonly allowSystemReboot: boolean
  readonly safety: SafetyConfig
  readonly supervisor: SupervisorConfig
  readonly storage: StorageConfig
  /** Reason codes accepted without complaint. Unknown codes are logged, not refused. */
  readonly knownReasonCodes: readonly string[]
}

/** A deeply partial configuration document. */
export type RestartConfigOverrides = {
  [K in keyof RestartConfig]?: RestartConfig[K] extends readonly unknown[]
    ? RestartConfig[K]
    : RestartConfig[K] extends object
      ? Partial<RestartConfig[K]>
      : RestartConfig[K]
}

/** The outcome of validating a request. */
export interface ValidationResult {
  /** Whether the request may proceed to execution. */
  readonly valid: boolean
  /** Machine-readable code when invalid, or `null`. */
  readonly code: string | null
  /** Human-readable explanation. */
  readonly detail: string
  /** The normalized request when valid. */
  readonly request: NormalizedRequest | null
}

/** A validated, immutable request. */
export interface NormalizedRequest {
  readonly requestId: string
  readonly source: string
  readonly mode: RestartMode
  readonly reasonCode: string
  readonly reasonSummary: string
  readonly checkpointRequired: boolean
  readonly priority: RestartPriority
  readonly createdAt: string
  readonly acknowledgeSystemReboot: boolean
}

/** What the harness must answer before a restart may be authorized. */
export interface CheckpointOutcome {
  /** Whether the harness reports that a restart is safe right now. */
  readonly safe: boolean
  /** Machine-readable reason, e.g. `git_commit_in_progress`. */
  readonly reason: string
  /** Checkpoint identifier the restart is authorized against, or `null`. */
  readonly checkpointId: string | null
  /** Token the harness can use to validate the resume after the restart. */
  readonly resumeToken: string | null
  /** Whether the harness completed its checkpoint without error. */
  readonly completed: boolean
  /** Free-form detail, safe to log. */
  readonly detail: string
}

/**
 * The checkpoint seam.
 *
 * `dsh-restart` never saves task state. It asks the harness to, and it believes
 * only the answer. There is deliberately no default implementation that reports
 * success: an unbound port means "cannot verify", which means "do not restart".
 */
export interface CheckpointPort {
  /** Stable port id, for diagnostics. */
  readonly id: string
  /** Ask the harness to prepare for a restart; may create a checkpoint. */
  prepareForRestart(mode: RestartMode): Promise<CheckpointOutcome> | CheckpointOutcome
  /** Report that the harness came back and the checkpoint was consumed. */
  acknowledgeResume(resumeToken: string | null): Promise<boolean> | boolean
}

/**
 * The shutdown seam.
 *
 * The only thing this plugin may ask the *host* to do. It never calls
 * `process.exit`, never signals a pid, and never shells out: the harness owns its
 * own lifecycle, and the supervisor owns the relaunch.
 */
export interface ShutdownPort {
  /** Stable port id, for diagnostics. */
  readonly id: string
  /**
   * Request a graceful shutdown of the harness.
   *
   * @param reason - the ticket id, so the harness can log why it is exiting.
   * @returns `true` when the request was accepted and the exit is expected.
   */
  requestShutdown(reason: string): Promise<boolean> | boolean
}

/** The system-reboot seam. */
export interface SystemShutdownPort {
  /** Stable port id, for diagnostics. */
  readonly id: string
  /**
   * Request an operating-system restart.
   *
   * Implemented by a Windows-only helper script in this repository. It is
   * deliberately a separate port from {@link ShutdownPort} so that "reboot the
   * machine" can be absent while "restart the app" works.
   */
  requestSystemRestart(reason: string, delaySeconds: number): Promise<boolean> | boolean
}
