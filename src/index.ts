/**
 * Public API of `dsh-restart`.
 *
 * Both the plugin entry point (it exports `name`, `inject` and `apply`, which is
 * what the Cordis loader looks for) and the library surface for embedding the
 * service directly. The engine has no dependency on the harness, so importing it
 * costs nothing and testing it needs no runtime.
 *
 * @module dsh-restart
 */

import { applyRestart, configResolvers } from './plugin/index.js'
import type { RestartConfigOverrides } from './shared/types.js'

export { applyRestart, configResolvers, statusPayload, SETTINGS_NAMESPACE, TOOL_NAMES } from './plugin/index.js'
export type { AppliedRestart, ApplyOptions, PluginDependencies } from './plugin/index.js'
export { resolveConfig, tryResolveConfig, deepMerge, ConfigError, DEFAULT_CONFIG } from './shared/config.js'
export {
  PROTOCOL_VERSION,
  TICKET_SCHEMA_VERSION,
  SELF_REASON_CODES,
  canonicalJson,
} from './shared/protocol.js'
export type {
  CooldownState,
  CrashLoopState,
  RestartActiveRequest,
  RestartAttemptRecord,
  RestartLockState,
  RestartMode,
  RestartPriority,
  RestartReasonCode,
  RestartRequest,
  RestartRequestState,
  RestartResponse,
  RestartStatus,
  RestartTicket,
  SupervisorHeartbeat,
  SupervisorLedger,
  SupervisorPresence,
  SupervisorState,
} from './shared/protocol.js'
export type {
  CheckpointOutcome,
  CheckpointPort,
  ModeConfig,
  NormalizedRequest,
  RestartConfig,
  RestartConfigOverrides,
  SafetyConfig,
  ShutdownPort,
  StorageConfig,
  SupervisorConfig,
  SystemShutdownPort,
  ValidationResult,
} from './shared/types.js'
export { RestartManager } from './plugin/restart-manager.js'
export { createHealthSchedulerBridge } from './plugin/health-scheduler-bridge.js'
export type {
  HealthSchedulerBridge,
  HealthSchedulerRestartAdapter,
  RestartRequestLike,
} from './plugin/health-scheduler-bridge.js'
export type { RestartManagerOptions, RestartManagerPorts } from './plugin/restart-manager.js'
export { RestartLock } from './plugin/restart-lock.js'
export { CheckpointGate, UnboundCheckpointPort } from './plugin/checkpoint-gate.js'
export { buildTicket, ticketChecksum, verifyTicket, TicketStore, emptyLedger } from './plugin/ticket-store.js'
export type { TicketDraft, TicketRejection, TicketStorePaths, TicketVerification } from './plugin/ticket-store.js'
export { validateRequest, validateShape, requestFingerprint, refuse } from './plugin/request-validator.js'
export type { ValidatorContext } from './plugin/request-validator.js'
export { RestartAuditLog, AUDIT_SCHEMA_VERSION } from './plugin/audit.js'
export {
  FileCheckpointPort,
  FunctionCheckpointPort,
  HostShutdownPort,
  RecordingLifecycle,
  WindowsSystemShutdownPort,
  runProcess,
  spawnSupervisor,
} from './plugin/ports.js'
export type { HostLifecycle, SpawnSupervisorOptions, SpawnedSupervisor } from './plugin/ports.js'
export { readJson, writeFileAtomic, writeJsonAtomic, sha256, mtimeMs, sizeBytes } from './plugin/atomic.js'
export { RestartSupervisor } from './supervisor/index.js'
export type {
  RestartSupervisorOptions,
  SupervisorEvent,
  SupervisorRunResult,
} from './supervisor/index.js'
export { CrashLoopBreaker } from './supervisor/crash-loop-breaker.js'
export type { BreakerVerdict, UncleanStart } from './supervisor/crash-loop-breaker.js'
export { HeartbeatWriter, readHeartbeat } from './supervisor/heartbeat.js'
export type { HeartbeatReading } from './supervisor/heartbeat.js'
export {
  SystemLivenessProbe,
  ScriptedLivenessProbe,
  parseTasklistOutput,
} from './supervisor/pid-watch.js'
export type { LivenessProbe, LivenessResult } from './supervisor/pid-watch.js'
export {
  ChildProcessLauncher,
  ScriptedLauncher,
  deriveLaunchSpec,
} from './supervisor/relaunch.js'
export type { LaunchResult, LaunchSpec, ProcessLauncher } from './supervisor/relaunch.js'

/** Cordis plugin name, matched by the bundle patch row. */
export const name = 'dsh-restart'

/**
 * Services this plugin needs before it activates.
 *
 * Nothing is required. The tools are the model-facing surface and the settings
 * namespace is how a deployment tunes the bounds, but the service itself works
 * without either — and a restart plugin that refuses to load because a UI service
 * is missing would be a plugin that takes the host down with it.
 */
export const inject: readonly string[] = []

/**
 * Cordis plugin entry point, called once per application load.
 *
 * @param ctx - the harness context.
 * @param config - plugin configuration; every leaf is optional.
 */
export function apply(ctx: unknown, config: RestartConfigOverrides = {}): void {
  applyRestart(ctx as never, config, configResolvers)
}
