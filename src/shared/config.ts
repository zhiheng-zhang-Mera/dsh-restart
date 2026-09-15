/**
 * Configuration resolution for `dsh-restart`.
 *
 * Same shape as the rest of the fleet: a default document, a deep merge, and a
 * validator that refuses anything the plugin could not act on. A configuration
 * that cannot be enforced is worse than no configuration, so an invalid document
 * is rejected at load time with a dotted path.
 *
 * @module dsh-restart/config
 */

import type {
  ModeConfig,
  RestartConfig,
  RestartConfigOverrides,
  SafetyConfig,
  StorageConfig,
  SupervisorConfig,
} from './types.js'
import type { RestartPriority } from './protocol.js'

const MINUTE = 60_000
const SECOND = 1_000

/** Thrown when a configuration document cannot be acted on. */
export class ConfigError extends Error {
  /** Dotted path of the offending value. */
  readonly path: string

  constructor(path: string, message: string) {
    super(`dsh-restart config: ${path} ${message}`)
    this.name = 'ConfigError'
    this.path = path
  }
}

/** The shipped defaults, matching the design document. */
export const DEFAULT_CONFIG: RestartConfig = Object.freeze({
  enabled: true,

  applicationRestart: Object.freeze({ enabled: true, minIntervalMs: 20 * MINUTE }),
  // System restart is off unless an operator turns it on. A reboot is the one
  // action here that can lose unrelated work on the machine.
  systemRestart: Object.freeze({ enabled: false, minIntervalMs: 60 * MINUTE }),

  allowedSources: Object.freeze(['dsh-health-scheduler', 'dsh-cli', 'operator']),
  allowedPriorities: Object.freeze(['low', 'normal', 'high', 'emergency'] as RestartPriority[]),

  allowSystemReboot: false,

  safety: Object.freeze({
    checkpointRequired: true,
    duplicateSuppression: true,
    crashLoopLimit: 3,
    crashLoopWindowMs: 10 * MINUTE,
    safeModeOnLoop: true,
    shutdownTimeoutMs: 90 * SECOND,
    allowForceTerminate: false,
    allowRestartWithoutSupervisor: false,
  }),

  supervisor: Object.freeze({
    heartbeatIntervalMs: 5 * SECOND,
    heartbeatTimeoutMs: 30 * SECOND,
    relaunchTimeoutMs: 90 * SECOND,
    launchCommand: null,
    launchArgs: Object.freeze([]),
    launchCwd: null,
    pollIntervalMs: 1 * SECOND,
    ticketTtlMs: 10 * MINUTE,
    detach: true,
  }),

  storage: Object.freeze({
    directory: null,
    maxLogBytes: 4 * 1024 * 1024,
    maxRecentAttempts: 25,
  }),

  knownReasonCodes: Object.freeze([
    'RUNTIME_PRESSURE',
    'SYSTEM_PRESSURE',
    'MEMORY_LEAK',
    'THERMAL_STRESS',
    'UI_DEGRADATION',
    'COMPUTER_USE_STALL',
    'SCHEDULED_MAINTENANCE',
    'OPERATOR_REQUEST',
    'TEST',
  ]),
})

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Recursively merge `override` into `base`; arrays replace, `undefined` is ignored. */
export function deepMerge<T>(base: T, override: unknown): T {
  if (override === undefined) return base
  if (override === null) return null as unknown as T
  if (Array.isArray(override)) return override as unknown as T
  if (!isPlainObject(override)) return override as unknown as T
  if (!isPlainObject(base)) return override as unknown as T
  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue
    out[key] = deepMerge((base as Record<string, unknown>)[key], value)
  }
  return out as unknown as T
}

function requireFinite(path: string, value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ConfigError(path, `must be a finite number, received ${JSON.stringify(value)}`)
  }
  return value
}

function requireNonNegative(path: string, value: unknown): number {
  const n = requireFinite(path, value)
  if (n < 0) throw new ConfigError(path, `must be >= 0, received ${n}`)
  return n
}

function requirePositive(path: string, value: unknown): number {
  const n = requireFinite(path, value)
  if (n <= 0) throw new ConfigError(path, `must be > 0, received ${n}`)
  return n
}

function requireBoolean(path: string, value: unknown): boolean {
  if (typeof value !== 'boolean') {
    throw new ConfigError(path, `must be a boolean, received ${JSON.stringify(value)}`)
  }
  return value
}

function requireMode(path: string, value: unknown): ModeConfig {
  if (!isPlainObject(value)) throw new ConfigError(path, 'must be an object')
  return {
    enabled: requireBoolean(`${path}.enabled`, value.enabled),
    minIntervalMs: requireNonNegative(`${path}.minIntervalMs`, value.minIntervalMs),
  }
}

function requireStringArray(path: string, value: unknown): readonly string[] {
  if (!Array.isArray(value)) throw new ConfigError(path, 'must be an array of strings')
  return value.map((entry, index) => {
    if (typeof entry !== 'string' || entry.trim() === '') {
      throw new ConfigError(`${path}[${index}]`, 'must be a non-empty string')
    }
    return entry.trim()
  })
}

function requirePriorityArray(path: string, value: unknown): readonly RestartPriority[] {
  const allowed: readonly string[] = ['low', 'normal', 'high', 'emergency']
  return requireStringArray(path, value).map((entry) => {
    if (!allowed.includes(entry)) {
      throw new ConfigError(`${path}[]`, `unknown priority ${JSON.stringify(entry)}; known: ${allowed.join(', ')}`)
    }
    return entry as RestartPriority
  })
}

/**
 * Resolve a user document against the shipped defaults.
 *
 * @param overrides - partial document.
 * @returns a frozen, fully-populated configuration.
 * @throws {ConfigError} when a value cannot be enforced.
 */
export function resolveConfig(overrides: RestartConfigOverrides = {}): RestartConfig {
  const merged = deepMerge<RestartConfig>(DEFAULT_CONFIG, overrides)

  if (!isPlainObject(merged.safety)) throw new ConfigError('safety', 'must be an object')
  if (!isPlainObject(merged.supervisor)) throw new ConfigError('supervisor', 'must be an object')
  if (!isPlainObject(merged.storage)) throw new ConfigError('storage', 'must be an object')

  const safety: SafetyConfig = {
    checkpointRequired: requireBoolean('safety.checkpointRequired', merged.safety.checkpointRequired),
    duplicateSuppression: requireBoolean('safety.duplicateSuppression', merged.safety.duplicateSuppression),
    crashLoopLimit: Math.max(
      1,
      Math.trunc(requirePositive('safety.crashLoopLimit', merged.safety.crashLoopLimit)),
    ),
    crashLoopWindowMs: requirePositive('safety.crashLoopWindowMs', merged.safety.crashLoopWindowMs),
    safeModeOnLoop: requireBoolean('safety.safeModeOnLoop', merged.safety.safeModeOnLoop),
    shutdownTimeoutMs: requirePositive('safety.shutdownTimeoutMs', merged.safety.shutdownTimeoutMs),
    allowForceTerminate: requireBoolean('safety.allowForceTerminate', merged.safety.allowForceTerminate),
    allowRestartWithoutSupervisor: requireBoolean(
      'safety.allowRestartWithoutSupervisor',
      merged.safety.allowRestartWithoutSupervisor,
    ),
  }

  const supervisor: SupervisorConfig = {
    heartbeatIntervalMs: requirePositive('supervisor.heartbeatIntervalMs', merged.supervisor.heartbeatIntervalMs),
    heartbeatTimeoutMs: requirePositive('supervisor.heartbeatTimeoutMs', merged.supervisor.heartbeatTimeoutMs),
    relaunchTimeoutMs: requirePositive('supervisor.relaunchTimeoutMs', merged.supervisor.relaunchTimeoutMs),
    launchCommand:
      merged.supervisor.launchCommand === null ? null : requireStringArray('supervisor.launchCommand', merged.supervisor.launchCommand),
    launchArgs: requireStringArray('supervisor.launchArgs', merged.supervisor.launchArgs ?? []),
    launchCwd: merged.supervisor.launchCwd === null ? null : String(merged.supervisor.launchCwd),
    pollIntervalMs: requirePositive('supervisor.pollIntervalMs', merged.supervisor.pollIntervalMs),
    ticketTtlMs: requirePositive('supervisor.ticketTtlMs', merged.supervisor.ticketTtlMs),
    detach: requireBoolean('supervisor.detach', merged.supervisor.detach),
  }

  if (supervisor.heartbeatTimeoutMs <= supervisor.heartbeatIntervalMs) {
    throw new ConfigError(
      'supervisor.heartbeatTimeoutMs',
      `must exceed supervisor.heartbeatIntervalMs (${supervisor.heartbeatIntervalMs}), received ${supervisor.heartbeatTimeoutMs}`,
    )
  }
  if (supervisor.relaunchTimeoutMs < supervisor.heartbeatIntervalMs) {
    throw new ConfigError(
      'supervisor.relaunchTimeoutMs',
      `must be at least supervisor.heartbeatIntervalMs (${supervisor.heartbeatIntervalMs})`,
    )
  }

  const storage: StorageConfig = {
    directory: merged.storage.directory === null ? null : String(merged.storage.directory),
    maxLogBytes: requirePositive('storage.maxLogBytes', merged.storage.maxLogBytes),
    maxRecentAttempts: Math.max(1, Math.trunc(requirePositive('storage.maxRecentAttempts', merged.storage.maxRecentAttempts))),
  }

  const resolved: RestartConfig = {
    enabled: requireBoolean('enabled', merged.enabled),
    applicationRestart: requireMode('applicationRestart', merged.applicationRestart),
    systemRestart: requireMode('systemRestart', merged.systemRestart),
    allowedSources: requireStringArray('allowedSources', merged.allowedSources ?? []),
    allowedPriorities: requirePriorityArray('allowedPriorities', merged.allowedPriorities ?? []),
    allowSystemReboot: requireBoolean('allowSystemReboot', merged.allowSystemReboot),
    safety,
    supervisor,
    storage,
    knownReasonCodes: requireStringArray('knownReasonCodes', merged.knownReasonCodes ?? []),
  }

  if (resolved.allowedSources.length === 0) {
    throw new ConfigError(
      'allowedSources',
      'must list at least one source; an empty list would refuse every request, including an operator request',
    )
  }

  return Object.freeze(resolved)
}

/**
 * Resolve from an untrusted source without throwing.
 *
 * Returns the resolved configuration plus the error when resolution failed, so a
 * plugin `apply` can report the problem and continue on the defaults instead of
 * failing the host's boot.
 */
export function tryResolveConfig(overrides: RestartConfigOverrides = {}): {
  readonly config: RestartConfig
  readonly error: ConfigError | null
} {
  try {
    return { config: resolveConfig(overrides), error: null }
  } catch (error) {
    const wrapped =
      error instanceof ConfigError ? error : new ConfigError('<root>', `failed to resolve: ${(error as Error).message}`)
    return { config: resolveConfig({}), error: wrapped }
  }
}
