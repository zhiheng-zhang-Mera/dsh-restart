/**
 * The wire protocol shared by `dsh-restart`, its supervisor, and any requester
 * (primarily `dsh-health-scheduler`).
 *
 * This module is the contract. Nothing here knows how a restart is performed; it
 * only names the shapes both sides agree on, so a requester can be written against
 * the protocol without importing the implementation, and the supervisor can parse
 * a ticket without trusting the process that wrote it.
 *
 * @module dsh-restart/protocol
 */

/** Current protocol version. Bump only for a breaking change. */
export const PROTOCOL_VERSION = 1

/** On-disk schema version of a restart ticket. */
export const TICKET_SCHEMA_VERSION = 1

/** Restart scope. */
export type RestartMode = 'application' | 'system'

/** How urgent the request is. Priority never bypasses validation. */
export type RestartPriority = 'low' | 'normal' | 'high' | 'emergency'

/**
 * Stable reason codes.
 *
 * `dsh-restart` does not interpret these beyond logging them: deciding *why* a
 * restart is wanted belongs to the requester. The codes exist so an operator can
 * grep an incident afterwards.
 */
export type RestartReasonCode =
  | 'RUNTIME_PRESSURE'
  | 'SYSTEM_PRESSURE'
  | 'MEMORY_LEAK'
  | 'THERMAL_STRESS'
  | 'UI_DEGRADATION'
  | 'COMPUTER_USE_STALL'
  | 'SCHEDULED_MAINTENANCE'
  | 'OPERATOR_REQUEST'
  | 'TEST'
  | (string & {})

/** Lifecycle state of one restart request. */
export type RestartRequestState =
  | 'rejected'
  | 'queued'
  | 'checkpointing'
  | 'shutting_down'
  | 'relaunching'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'

/** The exclusive restart lock. At most one restart is ever in flight. */
export type RestartLockState =
  | 'IDLE'
  | 'REQUESTED'
  | 'CHECKPOINTING'
  | 'SHUTTING_DOWN'
  | 'RELAUNCHING'
  | 'VERIFYING'

/** A request as submitted by a requester. */
export interface RestartRequest {
  /** Requester-chosen unique id. De-duplication keys on this and nothing else. */
  readonly requestId: string
  /** Requesting module id, e.g. `dsh-health-scheduler`. */
  readonly source: string
  /** Restart scope. */
  readonly mode: RestartMode
  /** Stable reason code. */
  readonly reasonCode: RestartReasonCode
  /** One-line human summary; never parsed. */
  readonly reasonSummary: string
  /**
   * Whether a checkpoint must succeed first. A request that needs one and cannot
   * get one is aborted, not downgraded.
   */
  readonly checkpointRequired: boolean
  /** Priority hint. */
  readonly priority: RestartPriority
  /** ISO-8601 instant the requester created the request. */
  readonly createdAt?: string
  /**
   * Explicit acknowledgement that this request may escalate to a system reboot.
   * Only consulted for `mode: "system"`; the configuration must also allow it.
   */
  readonly acknowledgeSystemReboot?: boolean
}

/** The answer to a submitted request. */
export interface RestartResponse {
  /** Whether the request was accepted and is (or was) being carried out. */
  readonly accepted: boolean
  /** Lifecycle state at the moment of the answer. */
  readonly state: RestartRequestState
  /** Machine-readable rejection or failure reason. */
  readonly reason?: string
  /** Human-readable explanation, safe to log and to show. */
  readonly detail: string
  /** The request id, echoed so a caller can correlate. */
  readonly requestId: string
  /** Ticket id when one was written. */
  readonly ticketId?: string
}

/** Everything an operator or a requester can ask about the current situation. */
export interface RestartStatus {
  /** ISO-8601 instant the status was read. */
  readonly timestamp: string
  /** Whether the configured restart capability is enabled at all. */
  readonly enabled: boolean
  /** Exclusive lock state. */
  readonly lock: RestartLockState
  /** The request currently holding the lock, or `null`. */
  readonly active: RestartActiveRequest | null
  /** Whether a restart may be attempted right now, and why not when it may not. */
  readonly canRestart: { readonly allowed: boolean; readonly reason: string }
  /** Cooldown picture for both restart modes. */
  readonly cooldowns: {
    readonly application: CooldownState
    readonly system: CooldownState
  }
  /** The most recent outcomes, newest first. */
  readonly recent: readonly RestartAttemptRecord[]
  /** Crash-loop breaker picture. */
  readonly crashLoop: CrashLoopState
  /** Whether the external supervisor has been seen recently. */
  readonly supervisor: SupervisorPresence
  /** Configured capabilities, so a degraded install is visible. */
  readonly capabilities: {
    readonly applicationRestart: boolean
    readonly systemRestart: boolean
    readonly checkpointPort: boolean
    readonly shutdownPort: boolean
    readonly supervisorWatch: boolean
  }
}

/** The in-flight request, as much of it as a caller may see. */
export interface RestartActiveRequest {
  readonly requestId: string
  readonly ticketId: string
  readonly source: string
  readonly mode: RestartMode
  readonly reasonCode: string
  readonly priority: RestartPriority
  readonly state: RestartRequestState
  readonly createdAt: string
  readonly updatedAt: string
  readonly attempts: number
}

/** Cooldown state for one restart mode. */
export interface CooldownState {
  /** Earliest instant another restart of this mode may start, ISO-8601. */
  readonly nextAllowedAt: string | null
  /** Milliseconds remaining, `0` when clear. */
  readonly remainingMs: number
  /** The enforced lower bound, in milliseconds. */
  readonly minimumIntervalMs: number
}

/** Crash-loop breaker picture. */
export interface CrashLoopState {
  /** Whether automatic restart is currently disabled by the breaker. */
  readonly tripped: boolean
  /** Unclean starts observed inside the window. */
  readonly failuresInWindow: number
  /** The configured limit. */
  readonly limit: number
  /** The configured window in milliseconds. */
  readonly windowMs: number
  /** When the breaker tripped, ISO-8601, or `null`. */
  readonly trippedAt: string | null
  /** Why it tripped, machine-readable. */
  readonly reason: string | null
}

/** Whether the external supervisor is alive. */
export interface SupervisorPresence {
  /** Whether a supervisor heartbeat has been seen inside the timeout. */
  readonly present: boolean
  /** Instant of the last heartbeat, ISO-8601, or `null`. */
  readonly lastSeenAt: string | null
  /** Age of the last heartbeat, or `null`. */
  readonly ageMs: number | null
}

/** One completed or rejected attempt, kept for the audit trail. */
export interface RestartAttemptRecord {
  readonly requestId: string
  readonly ticketId: string | null
  readonly mode: RestartMode
  readonly source: string
  readonly reasonCode: string
  readonly state: RestartRequestState
  readonly startedAt: string
  readonly finishedAt: string
  readonly detail: string
  /** Whether the process was asked to exit cleanly or was terminated. */
  readonly clean: boolean
  /** Why the attempt ended, machine-readable. */
  readonly outcomeCode: string
}

/**
 * The on-disk ticket.
 *
 * The supervisor is a different process and must not trust the running plugin, so
 * the ticket is a self-describing, versioned, checksummed document. It is written
 * atomically (temp file + fsync + rename) so a hard kill can never leave a
 * half-written ticket that a supervisor would act on.
 */
export interface RestartTicket {
  /** On-disk schema version. */
  readonly schemaVersion: number
  /** Ticket id, unique per written ticket. */
  readonly ticketId: string
  /** The requester's request id, for correlation. */
  readonly requestId: string
  /** Restart scope. */
  readonly mode: RestartMode
  /** Reason code, for the operator's benefit. */
  readonly reasonCode: string
  /** Reason summary, for the operator's benefit. */
  readonly reasonSummary: string
  /** Process id the supervisor should watch. */
  readonly pid: number
  /** ISO-8601 instant the ticket was written. */
  readonly createdAt: string
  /** ISO-8601 instant after which the ticket is void. */
  readonly expiresAt: string
  /** Whether the shutdown was requested cleanly and acknowledged. */
  readonly cleanShutdown: boolean
  /** Checkpoint id the restart was authorized against, or `null`. */
  readonly checkpointId: string | null
  /** `sha256:<hex>` over the ticket's canonical JSON without this field. */
  readonly checksum: string
}

/** Supervisor state machine. */
export type SupervisorState =
  | 'MONITORING'
  | 'WAITING_FOR_EXIT'
  | 'RELAUNCHING'
  | 'WAITING_FOR_HEARTBEAT'
  | 'VERIFIED'
  | 'CRASH_LOOP'
  | 'SAFE_MODE'
  | 'STOPPED'

/** One supervisor heartbeat, written where the plugin can read it. */
export interface SupervisorHeartbeat {
  readonly schemaVersion: number
  readonly supervisorPid: number
  /** The harness pid the supervisor believes it is watching. */
  readonly watchedPid: number
  readonly state: SupervisorState
  /** ISO-8601 instant. */
  readonly timestamp: string
  /** Monotonic sequence, so a reader can tell a fresh beat from a stale file. */
  readonly sequence: number
}

/** The supervisor's own durable record of what it has done. */
export interface SupervisorLedger {
  readonly schemaVersion: number
  /** Unclean starts, newest last. */
  readonly uncleanStarts: readonly { readonly at: string; readonly reason: string }[]
  /** Whether the breaker has disabled automatic restart. */
  readonly safeMode: boolean
  /** Why safe mode was entered, or `null`. */
  readonly safeModeReason: string | null
  /** When safe mode was entered, ISO-8601, or `null`. */
  readonly safeModeAt: string | null
  /** Total relaunch attempts observed. */
  readonly relaunches: number
}

/** Canonical JSON with sorted keys, so a checksum is reproducible. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(',')}}`
}

/** Reason codes the plugin itself may raise. */
export const SELF_REASON_CODES: Readonly<Record<string, string>> = Object.freeze({
  DUPLICATE_REQUEST_ID: 'a request with this id has already been processed',
  UNKNOWN_SOURCE: 'the requesting source is not in the allow list',
  MODE_NOT_ALLOWED: 'this restart mode is disabled by configuration',
  SYSTEM_REBOOT_NOT_PERMITTED: 'system restart requires an explicit permission and acknowledgement',
  RESTART_IN_FLIGHT: 'another restart is already in progress',
  COOLDOWN_ACTIVE: 'the minimum interval for this restart mode has not elapsed',
  CHECKPOINT_REQUIRED: 'this request requires a checkpoint and none was produced',
  CHECKPOINT_FAILED: 'the harness refused to prepare a checkpoint',
  SHUTDOWN_TIMEOUT: 'the process did not exit inside the shutdown budget',
  SHUTDOWN_PORT_UNAVAILABLE: 'no shutdown capability is bound, so a graceful restart is impossible',
  SUPERVISOR_ABSENT: 'no supervisor heartbeat was seen, so a restart could not be observed',
  CRASH_LOOP: 'the crash-loop breaker has disabled automatic restart',
  INVALID_REQUEST: 'the request did not satisfy the protocol',
  DISABLED: 'restart execution is disabled by configuration',
})
